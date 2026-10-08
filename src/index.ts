export {
  defineConfig,
  validateConfig,
  resolveConfig,
  collectionsOf,
  triggerName,
  needsCollectionGroupQuery,
  collectionGroupQueries,
  defineView,
  rulesOf,
  ConfigError,
  type Connection,
  type AggregateRule,
  type DocSyncConfig,
  type ResolvedConfig,
  type ResolvedConnection,
  type ResolvedAggregate,
  type ResolvedRule,
  type OnSourceDelete,
  type ViewRule,
  type ViewSource,
  type ViewOrder,
  type ViewChange,
  type BuildContext,
  type PatchContext,
  type ResolvedView,
  type ResolvedViewSource,
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
  type SyncOptions,
  type DeletedSource,
  type CheckResult,
  type CheckOptions,
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
export { rebuild, type RebuildOptions, type RebuildProgress, type RebuildResult } from './rebuild.js'
export { verify, type VerifyOptions, type VerifyProgress, type VerifyResult, type Mismatch } from './verify.js'
export { startDevBridge, type DevBridge, type DevBridgeOptions } from './dev.js'
