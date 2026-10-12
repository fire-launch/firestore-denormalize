/**
 * Continuation of scheduled runs: when `/schedule/<rule>` stops on its time budget, the handler
 * enqueues a Cloud Tasks task that calls the same URL again with the cursor in the body. The
 * cursor never touches the user's Firestore.
 */
import { createHash } from 'node:crypto'

/** A base or target document a deferred rule has not yet recomputed for. */
export interface DirtyUnit {
  unit: 'source' | 'target'
  path: string
}

export interface ContinuationBody {
  /** Last document path the previous chunk processed (`RebuildResult.lastPath`). */
  startAfter: string
  /** Identifies one pass over the collection (all its chunks share it). */
  runId: string
  /** 0 for the chunk the Scheduler started, then 1, 2, ... */
  chunk: number
  /** When the pass started (ISO 8601). */
  startedAt: string
}

export interface ContinuationTask {
  /** Cloud Tasks task id `<rule>-<runId>-<chunk>`: unique per chunk, so a retried chunk cannot enqueue its successor twice. */
  id: string
  rule: string
  /** `<serviceUrl>/schedule/<rule>`. */
  url: string
  body: ContinuationBody | { flush: DirtyUnit }
  /** When set, the task runs no earlier than this time (ISO 8601), e.g. the end of a defer bucket. */
  scheduleTime?: string
  /** OIDC identity of the task call (the trigger service account) and its audience (the service URL). */
  serviceAccountEmail: string
  audience: string
  queue: { project: string; location: string; name: string }
}

/**
 * The defer bucket a dirty unit falls into at `now`: the interval `[bucket - 1, bucket) * everyMs`
 * has just closed, so the recompute runs at `bucket * everyMs`. `bucket` groups units that should
 * be recomputed together; `scheduleTime` is when the Cloud Tasks task should run.
 */
export function deferBucket(everyMs: number, now: number = Date.now()): { bucket: number; scheduleTime: string } {
  const bucket = Math.floor(now / everyMs) + 1
  return { bucket, scheduleTime: new Date(bucket * everyMs).toISOString() }
}

/** Cloud Tasks task id for one dirty unit's bucket: stable, so retries of the same unit/bucket dedupe. */
export function deferTaskId(rule: string, bucket: number, unit: DirtyUnit): string {
  const hash = createHash('sha256').update(`${unit.unit}\n${unit.path}`).digest('hex').slice(0, 16)
  return `${rule}-d${bucket}-${hash}`
}

/** Enqueues one continuation task. The default implementation calls the Cloud Tasks REST API with ADC. */
export type Enqueue = (task: ContinuationTask) => Promise<void>

const TASK_ID_CHARS = /[^A-Za-z0-9_-]/g

/** The run id: the body's (a continuation), else the Scheduler's schedule time, else the clock. Always a valid task-id segment. */
export function continuationRunId(bodyRunId: unknown, scheduleTimeHeader: string | undefined, now: number = Date.now()): string {
  const raw = typeof bodyRunId === 'string' && bodyRunId.length > 0 ? bodyRunId : scheduleTimeHeader && scheduleTimeHeader.length > 0 ? scheduleTimeHeader : now.toString(36)
  return raw.replace(TASK_ID_CHARS, '-')
}

/** The continuation fields of a request body (JSON text, bytes or an already-parsed object); fields of the wrong type are dropped. */
export function parseContinuationBody(body: unknown): Partial<ContinuationBody> {
  let data: unknown = body
  if (data instanceof Uint8Array) data = Buffer.from(data).toString('utf8')
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return {}
    }
  }
  if (data === null || typeof data !== 'object') return {}
  const o = data as Record<string, unknown>
  const out: Partial<ContinuationBody> = {}
  if (typeof o.startAfter === 'string' && o.startAfter.length > 0) out.startAfter = o.startAfter
  if (typeof o.runId === 'string' && o.runId.length > 0) out.runId = o.runId
  if (typeof o.chunk === 'number' && Number.isInteger(o.chunk) && o.chunk >= 0) out.chunk = o.chunk
  if (typeof o.startedAt === 'string' && o.startedAt.length > 0) out.startedAt = o.startedAt
  return out
}

/** The `tasks.create` call for a task: URL and JSON payload (Cloud Tasks v2 REST). */
export function buildContinuationRequest(task: ContinuationTask): { url: string; payload: unknown } {
  const parent = `projects/${task.queue.project}/locations/${task.queue.location}/queues/${task.queue.name}`
  return {
    url: `https://cloudtasks.googleapis.com/v2/${parent}/tasks`,
    payload: {
      task: {
        name: `${parent}/tasks/${task.id}`,
        dispatchDeadline: '1800s',
        ...(task.scheduleTime ? { scheduleTime: task.scheduleTime } : {}),
        httpRequest: {
          httpMethod: 'POST',
          url: task.url,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(task.body)).toString('base64'),
          oidcToken: { serviceAccountEmail: task.serviceAccountEmail, audience: task.audience },
        },
      },
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retries a transient `enqueue` failure (e.g. a Cloud Tasks 503 or timeout) up to `attempts`
 * times, waiting `waitMs(attempt)` between tries. The 409-as-success case is already handled
 * inside `enqueue` (see {@link createCloudTasksEnqueuer}), so every rejection here is a real
 * failure; the last one is rethrown once `attempts` is exhausted.
 */
export async function enqueueWithRetry(
  enqueue: Enqueue,
  task: ContinuationTask,
  attempts = 3,
  waitMs: (attempt: number) => number = (n) => n * 1000,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await enqueue(task)
      return
    } catch (err) {
      if (attempt >= attempts) throw err
      await sleep(waitMs(attempt))
    }
  }
}

/**
 * The default enqueuer: Cloud Tasks REST with Application Default Credentials (the function's
 * runtime service account on Cloud Run). A task that already exists (HTTP 409) counts as enqueued.
 */
export function createCloudTasksEnqueuer(): Enqueue {
  type Client = { request: (opts: { url: string; method: 'POST'; data: unknown; timeout?: number }) => Promise<unknown> }
  type Auth = { getClient: () => Promise<Client> }
  // The GoogleAuth instance itself (not a getClient() call result) is cached: a transient
  // getClient() failure must not poison every later continuation on this instance.
  let authPromise: Promise<Auth> | undefined
  return async (task) => {
    if (!authPromise) {
      authPromise = import('google-auth-library').then(({ GoogleAuth }) => new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' }) as unknown as Auth)
    }
    const auth = await authPromise
    const client = await auth.getClient()
    const { url, payload } = buildContinuationRequest(task)
    try {
      await client.request({ url, method: 'POST', data: payload, timeout: 30_000 })
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status ?? (err as { code?: number }).code
      if (status === 409) return
      throw err
    }
  }
}
