export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/** Agent identifier — one of the supported AI provider backends. */
export type AgentKind = "claude" | "codex";

export const CLAUDE_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_EFFORT_VALUES = ["minimal", "low", "medium", "high", "xhigh"] as const;

export type EffortLevel =
  | (typeof CLAUDE_EFFORT_VALUES)[number]
  | (typeof CODEX_EFFORT_VALUES)[number];

export const EFFORT_VALUES = [
  "minimal", "low", "medium", "high", "xhigh", "max",
] as const satisfies readonly EffortLevel[];

export interface PerAgentSettings {
  model?: string;
  effort?: EffortLevel;
  modelPinned?: boolean;
  effortPinned?: boolean;
}

export type AgentSettings = {
  [K in AgentKind]?: PerAgentSettings;
};

/**
 * Normalized events yielded by any agent provider (claudeProvider, codexProvider).
 * `user_message` is written by the query handler before runAgent() starts, not by providers.
 */
export type UnifiedEvent =
  | { type: "user_message"; content: string }
  | { type: "session"; sessionId: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "tool_progress"; toolName: string; elapsed: number }
  | { type: "tool_use_summary"; summary: string }
  | { type: "tool_result"; toolUseId: string; content: string }
  | { type: "text_delta"; content: string }
  | { type: "text"; content: string }
  | { type: "result"; content: string; stopReason: string; usage?: TokenUsage }
  | { type: "file"; path: string; source: string; origin?: "tag" | "extension" }
  | { type: "error"; content: string };

/** Backward-compat alias */
export type ClaudeEvent = UnifiedEvent;

export interface AgentQueryOptions {
  agent?: AgentKind;
  prompt: string;
  sessionId?: string | null;
  cwd: string;
  systemPrompt: string;
  userId?: string;
  session?: string;
  sessionType?: "dm" | "forum" | "ephemeral";
  abortController?: AbortController;
  model?: string;
  depth?: number;
  silent?: boolean;
  agents?: Record<string, { description: string; prompt: string; model?: string; tools?: string[]; maxTurns?: number; effort?: EffortLevel | number }>;
  effort?: EffortLevel;
  mcpEnabled?: string[] | null;
  mcpExtra?: Record<string, unknown>;
  groupId?: number;
  isCron?: boolean;
  advisorEnabled?: boolean;
}

/** Backward-compat alias */
export type ClaudeQueryOptions = AgentQueryOptions;

/** State file written to data/users/{userId}/active-queries/{topic}.json while a query is running. */
export interface QueryState {
  task?: string;
  since: string;
}
