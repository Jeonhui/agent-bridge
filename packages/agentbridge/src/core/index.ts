export { ERROR_CODES, isErrorCode, type ErrorCode, type ErrorCodeSpec } from "./errors/codes.js";
export { AgentBridgeError, type AgentBridgeErrorInfo } from "./errors/AgentBridgeError.js";

export * from "./events/types.js";
export { EventBus, type EventBusOptions } from "./events/EventBus.js";
export { SequenceCounter } from "./events/sequence.js";

export type {
  AgentSession,
  CreateSessionOptions,
  PermissionMode,
  SessionStatus,
} from "./session/types.js";
export {
  acceptsMessage,
  allowedActions,
  canTransition,
  nextStatus,
  type SessionAction,
} from "./session/stateMachine.js";
export {
  SessionManager,
  type SendResult,
  type SessionManagerOptions,
  type SessionProvider,
  type SessionProviderLookup,
} from "./session/SessionManager.js";

export {
  AgentBridge,
  type CreateSessionInput,
  type McpBinding,
  type PermissionBinding,
  type ProviderRegistration,
  type Session,
  type ToolCallOptions,
  type ToolCallResult,
  type ToolDescriptor,
} from "./agent/AgentBridge.js";
export { AgentDirectory, type AgentDefinition } from "./agent/AgentDirectory.js";
export { resolveConfig, type AgentBridgeConfig, type ResolvedConfig } from "./agent/config.js";

export type { AuditRecord, Identified, Repository, Storage } from "./storage/Storage.js";
export { MemoryStorage } from "./storage/MemoryStorage.js";
export { FileStorage, type FileStorageOptions } from "./storage/FileStorage.js";

export {
  SECRET_PREFIX,
  isSecretReference,
  parseSecretReference,
  resolveSecrets,
  type SecretReference,
  type SecretResolver,
} from "./secrets/SecretResolver.js";
export {
  ChainSecretResolver,
  EnvSecretResolver,
  KeychainSecretResolver,
  MapSecretResolver,
} from "./secrets/resolvers.js";

export { Logger, type LogLevel, type LogRecord, type LoggerOptions } from "./logging/Logger.js";
export {
  REDACTED,
  abbreviatePath,
  digest,
  redact,
  summarizeArguments,
  summarizeContent,
} from "./logging/redaction.js";
