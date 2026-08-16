export type {
  AgentProvider,
  AgentStartOptions,
  McpTransport,
  ProviderCapabilities,
  ProviderDetection,
  ProviderEmit,
  ProviderInfo,
  ProviderSessionHandle,
  ResolvedMcpServer,
  SendOptions,
} from "./AgentProvider.js";

export { ProviderManager, type ProviderManagerOptions } from "./ProviderManager.js";

export {
  detectExecutable,
  parseVersion,
  resolveExecutable,
  type DetectExecutableOptions,
} from "./detect.js";

export {
  BUILTIN_PROVIDERS,
  listAgents,
  type BuiltinProviderSpec,
  type DetectedAgent,
} from "./builtin.js";

export { StreamParser, type ParsedLine } from "./process/StreamParser.js";
export {
  ProcessRunner,
  type ProcessExit,
  type ProcessRunnerOptions,
  type ProcessSignal,
} from "./process/ProcessRunner.js";
