/**
 * `doc-sync dev`: bridge Firestore emulator changes to the handler as CloudEvents.
 *
 * The Emulator Suite has no Eventarc for Firestore, so this listens to the configured
 * collections with `onSnapshot`, encodes each change in the protobuf format Eventarc
 * uses in production, and POSTs it to the handler URL. Only public APIs are used.
 */
import { randomUUID } from 'node:crypto'
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore'
import { collectionsOf, type DocSyncConfig, validateConfig } from './config.js'
import { encodeDocumentEventData } from './encode.js'
import { jsonLogger, type Logger } from './logger.js'
import { matchDocumentPath } from './paths.js'

export interface DevBridgeOptions {
  firestore: Firestore
  /** Handler URL, e.g. `http://127.0.0.1:5001/<project>/<region>/docSync`. */
  url: string
  project: string
  logger?: Logger
  /** Override for tests. */
  fetch?: typeof fetch
  /** Called after each delivery. `id` is the CloudEvent id (`ce-id`) the handler saw. */
  onDelivered?: (info: { id: string; document: string; change: 'create' | 'update' | 'delete'; status: number }) => void
}

export interface DevBridge {
  /** Resolves once every collection listener has received its initial snapshot. */
  ready: Promise<void>
  /** Resolves when deliveries in flight have finished. */
  idle(): Promise<void>
  stop(): void
}

export function startDevBridge(config: DocSyncConfig, options: DevBridgeOptions): DevBridge {
  const resolved = validateConfig(config)
  const logger = options.logger ?? jsonLogger
  const doFetch = options.fetch ?? fetch
  const database = resolved.database
  const previous = new Map<string, DocumentSnapshot>()
  const unsubscribes: (() => void)[] = []
  const inFlight = new Set<Promise<void>>()
  const readies: Promise<void>[] = []

  for (const pattern of collectionsOf(resolved)) {
    const query = pattern.params.length
      ? options.firestore.collectionGroup(pattern.collectionId)
      : options.firestore.collection(pattern.raw)
    let initial = true
    let markReady!: () => void
    readies.push(new Promise<void>((r) => (markReady = r)))

    const unsubscribe = query.onSnapshot(
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          const path = change.doc.ref.path
          if (!matchDocumentPath(pattern, path)) continue
          const before = previous.get(path)
          if (change.type === 'removed') previous.delete(path)
          else previous.set(path, change.doc)
          if (initial) continue // existing documents: cache only, no events

          const after = change.type === 'removed' ? undefined : change.doc
          const kind = change.type === 'added' ? 'create' : change.type === 'removed' ? 'delete' : 'update'
          const p = deliver(path, before, after, kind).finally(() => inFlight.delete(p))
          inFlight.add(p)
        }
        if (initial) {
          initial = false
          logger.info('doc-sync dev: watching', { collection: pattern.raw, documents: snapshot.size })
          markReady()
        }
      },
      (err) => logger.error('doc-sync dev: listener failed', { collection: pattern.raw, error: err }),
    )
    unsubscribes.push(unsubscribe)
  }

  async function deliver(
    document: string,
    before: DocumentSnapshot | undefined,
    after: DocumentSnapshot | undefined,
    change: 'create' | 'update' | 'delete',
  ): Promise<void> {
    const body = encodeDocumentEventData(before, after, { project: options.project, database })
    const id = randomUUID()
    const headers = {
      'content-type': 'application/protobuf',
      'ce-specversion': '1.0',
      'ce-id': id,
      'ce-type': 'google.cloud.firestore.document.v1.written',
      'ce-source': `//firestore.googleapis.com/projects/${options.project}/databases/${database}`,
      'ce-time': new Date().toISOString(),
      'ce-project': options.project,
      'ce-database': database,
      'ce-namespace': '(default)',
      'ce-document': document,
    }
    try {
      const res = await doFetch(options.url, { method: 'POST', headers, body })
      logger.info('doc-sync dev: delivered', { document, change, status: res.status })
      options.onDelivered?.({ id, document, change, status: res.status })
    } catch (err) {
      logger.error('doc-sync dev: delivery failed', { document, change, error: err })
    }
  }

  return {
    ready: Promise.all(readies).then(() => undefined),
    idle: () => Promise.all([...inFlight]).then(() => undefined),
    stop: () => unsubscribes.forEach((u) => u()),
  }
}
