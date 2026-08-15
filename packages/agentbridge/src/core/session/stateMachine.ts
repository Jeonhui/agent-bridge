import type { SessionStatus } from "./types.js";

/** State machine from spec 13.2. Any transition not listed here is forbidden. */
export type SessionAction =
  | "started"
  | "send"
  | "turn_end"
  | "await_input"
  | "resolve_input"
  | "interrupt"
  | "resume"
  | "stop"
  | "fail";

const TRANSITIONS: Record<SessionStatus, Partial<Record<SessionAction, SessionStatus>>> = {
  starting: { started: "ready", stop: "stopped", fail: "error" },
  ready: { send: "running", stop: "stopped", fail: "error" },
  running: {
    turn_end: "ready",
    await_input: "waiting",
    interrupt: "ready",
    stop: "stopped",
    fail: "error",
  },
  waiting: {
    resolve_input: "running",
    interrupt: "ready",
    stop: "stopped",
    fail: "error",
  },
  stopped: { resume: "starting" },
  error: { resume: "starting", stop: "stopped" },
};

export function nextStatus(
  current: SessionStatus,
  action: SessionAction,
): SessionStatus | undefined {
  return TRANSITIONS[current][action];
}

export function canTransition(current: SessionStatus, action: SessionAction): boolean {
  return nextStatus(current, action) !== undefined;
}

export function allowedActions(current: SessionStatus): SessionAction[] {
  return Object.keys(TRANSITIONS[current]) as SessionAction[];
}

/**
 * Whether the session can accept a message. For `running`, the caller decides
 * based on whether queueing is enabled.
 */
export function acceptsMessage(current: SessionStatus): boolean {
  return current === "ready" || current === "running";
}
