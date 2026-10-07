export {
  defineConfig,
  validateConfig,
  collectionsOf,
  triggerName,
  ConfigError,
  type Connection,
  type DocSyncConfig,
  type ResolvedConfig,
  type OnSourceDelete,
} from './config.js'
export {
  createDocSyncHandler,
  RetriesExhaustedError,
  type DocSyncHandler,
  type DocSyncHandlerOptions,
  type DocSyncRequest,
  type DocSyncResponse,
  type ConnectionResult,
} from './handler.js'
export { decodeDocumentEventData, DecodeError, type DecodedEvent, type DecodedDocument } from './decode.js'
export { isEqual } from './equal.js'
export { jsonLogger, type Logger } from './logger.js'
