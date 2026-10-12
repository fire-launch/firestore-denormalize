import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContinuationRequest, continuationRunId, createCloudTasksEnqueuer, enqueueWithRetry, parseContinuationBody, scheduleQueueName, type ContinuationTask, type Enqueue } from '../../src/index.js'

const requestMock = vi.fn()
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: async () => ({ request: requestMock }),
  })),
}))

describe('schedule continuation helpers', () => {
  it('derives the run id from the body, then the Scheduler header, then the clock', () => {
    expect(continuationRunId('abc', '2026-10-12T03:00:00Z')).toBe('abc')
    expect(continuationRunId(undefined, '2026-10-12T03:00:00Z')).toBe('2026-10-12T03-00-00Z')
    expect(continuationRunId(42, undefined, 1760238000000)).toBe((1760238000000).toString(36))
    expect(continuationRunId('bad id!', undefined, 1)).toBe('bad-id-')
  })

  it('parses only well-typed body fields', () => {
    expect(parseContinuationBody({ startAfter: 'post/p1', runId: 'r', chunk: 2, startedAt: '2026-10-12T03:00:00.000Z' })).toEqual({ startAfter: 'post/p1', runId: 'r', chunk: 2, startedAt: '2026-10-12T03:00:00.000Z' })
    expect(parseContinuationBody({ startAfter: 1, runId: {}, chunk: 'x', startedAt: 5 })).toEqual({})
    expect(parseContinuationBody(JSON.stringify({ startAfter: 'post/p1' }))).toEqual({ startAfter: 'post/p1' })
    expect(parseContinuationBody(Buffer.from('{"chunk":3}'))).toEqual({ chunk: 3 })
    expect(parseContinuationBody('not json')).toEqual({})
    expect(parseContinuationBody(undefined)).toEqual({})
  })

  it('builds the Cloud Tasks create request', () => {
    const task: ContinuationTask = {
      id: 'daily-likes-r1-1',
      rule: 'daily-likes',
      url: 'https://docsync-abc-an.a.run.app/schedule/daily-likes',
      body: { startAfter: 'post/p1', runId: 'r1', chunk: 1, startedAt: '2026-10-12T03:00:00.000Z' },
      serviceAccountEmail: 'doc-sync-trigger@my-proj.iam.gserviceaccount.com',
      audience: 'https://docsync-abc-an.a.run.app',
      queue: { project: 'my-proj', location: 'asia-northeast1', name: 'doc-sync-schedule' },
    }
    const { url, payload } = buildContinuationRequest(task)
    expect(url).toBe('https://cloudtasks.googleapis.com/v2/projects/my-proj/locations/asia-northeast1/queues/doc-sync-schedule/tasks')
    expect(payload).toEqual({
      task: {
        name: 'projects/my-proj/locations/asia-northeast1/queues/doc-sync-schedule/tasks/daily-likes-r1-1',
        dispatchDeadline: '1800s',
        httpRequest: {
          httpMethod: 'POST',
          url: task.url,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(task.body)).toString('base64'),
          oidcToken: { serviceAccountEmail: task.serviceAccountEmail, audience: task.audience },
        },
      },
    })
    expect(scheduleQueueName('doc-sync')).toBe('doc-sync-schedule')
  })
})

describe('enqueueWithRetry', () => {
  const task: ContinuationTask = {
    id: 'daily-likes-r1-1',
    rule: 'daily-likes',
    url: 'https://docsync-abc-an.a.run.app/schedule/daily-likes',
    body: { startAfter: 'post/p1', runId: 'r1', chunk: 1, startedAt: '2026-10-12T03:00:00.000Z' },
    serviceAccountEmail: 'doc-sync-trigger@my-proj.iam.gserviceaccount.com',
    audience: 'https://docsync-abc-an.a.run.app',
    queue: { project: 'my-proj', location: 'asia-northeast1', name: 'doc-sync-schedule' },
  }
  const noWait = () => 0

  it('retries a failing enqueue and resolves once it succeeds', async () => {
    let calls = 0
    const enqueue: Enqueue = async () => {
      calls++
      if (calls < 3) throw new Error('503')
    }
    await enqueueWithRetry(enqueue, task, 3, noWait)
    expect(calls).toBe(3)
  })

  it('rethrows after exhausting its attempts', async () => {
    let calls = 0
    const enqueue: Enqueue = async () => {
      calls++
      throw new Error('503')
    }
    await expect(enqueueWithRetry(enqueue, task, 3, noWait)).rejects.toThrow('503')
    expect(calls).toBe(3)
  })
})

describe('createCloudTasksEnqueuer', () => {
  const task: ContinuationTask = {
    id: 'daily-likes-r1-1',
    rule: 'daily-likes',
    url: 'https://docsync-abc-an.a.run.app/schedule/daily-likes',
    body: { startAfter: 'post/p1', runId: 'r1', chunk: 1, startedAt: '2026-10-12T03:00:00.000Z' },
    serviceAccountEmail: 'doc-sync-trigger@my-proj.iam.gserviceaccount.com',
    audience: 'https://docsync-abc-an.a.run.app',
    queue: { project: 'my-proj', location: 'asia-northeast1', name: 'doc-sync-schedule' },
  }

  beforeEach(() => {
    requestMock.mockReset()
  })

  it('treats a 409 (task already exists) as success', async () => {
    requestMock.mockRejectedValueOnce({ response: { status: 409 } })
    const enqueue = createCloudTasksEnqueuer()
    await expect(enqueue(task)).resolves.toBeUndefined()
  })

  it('rejects on any other error', async () => {
    requestMock.mockRejectedValueOnce({ response: { status: 500 } })
    const enqueue = createCloudTasksEnqueuer()
    await expect(enqueue(task)).rejects.toMatchObject({ response: { status: 500 } })
  })

  it('calls the Cloud Tasks REST API with a POST and a 30s timeout', async () => {
    requestMock.mockResolvedValueOnce({})
    const enqueue = createCloudTasksEnqueuer()
    await enqueue(task)
    expect(requestMock).toHaveBeenCalledWith({
      url: 'https://cloudtasks.googleapis.com/v2/projects/my-proj/locations/asia-northeast1/queues/doc-sync-schedule/tasks',
      method: 'POST',
      data: expect.anything(),
      timeout: 30_000,
    })
  })
})
