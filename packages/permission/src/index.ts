export {
  evaluate,
  extractPaths,
  globToRegExp,
  ruleMatches,
  validateRule,
  type Effect,
  type EvaluationContext,
  type Permission,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRule,
} from "./policy.js";

export {
  PermissionManager,
  type ApprovalRequest,
  type AuthorizeInput,
  type PermissionLogger,
  type PermissionManagerOptions,
  type PermissionStore,
  type RememberScope,
} from "./PermissionManager.js";
