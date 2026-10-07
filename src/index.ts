export {
  defineConfig,
  validateConfig,
  collectionsOf,
  triggerName,
  needsCollectionGroupQuery,
  ConfigError,
  type Connection,
  type AggregateRule,
  type DocSyncConfig,
  type ResolvedConfig,
  type ResolvedConnection,
  type ResolvedAggregate,
  type ResolvedRule,
  type OnSourceDelete,
} from './config.js'
export {
  createDocSyncHandler,
  Processor,
  RetriesExhaustedError,
  type DocSyncHandler,
  type DocSyncHandlerOptions,
  type DocSyncRequest,
  type DocSyncResponse,
  type RuleResult,
  type ConnectionResult,
} from './handler.js'
export { decodeDocumentEventData, DecodeError, type DecodedEvent, type DecodedDocument } from './decode.js'
export { encodeDocumentEventData, type EncodableDocument } from './encode.js'
export { isEqual } from './equal.js'
export { jsonLogger, type Logger } from './logger.js'
export {
  parseCollectionPattern,
  matchDocumentPath,
  resolveCollectionPath,
  eventarcPathPattern,
  type CollectionPattern,
  type DocumentMatch,
} from './paths.js'
