export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/** Normalized events yielded by claudeQuery() */
export type ClaudeEvent =
  | { type: "session"; sessionId: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "tool_progress"; toolName: string; elapsed: number }
  | { type: "tool_use_summary"; summary: string }
  | { type: "tool_result"; toolUseId: string; content: string }
  | { type: "text_delta"; content: string }
  | { type: "text"; content: string }
  | { type: "result"; content: string; stopReason: string; usage?: TokenUsage }
  | { type: "file"; path: string; source: string }
  | { type: "error"; content: string };

export interface ClaudeQueryOptions {
  prompt: string;
  sessionId?: string | null;
  cwd?: string;
  systemPrompt?: string;
  userId?: string;
  session?: string;
  sessionType?: 'dm' | 'forum' | 'ephemeral';
  abortController?: AbortController;
  model?: string;
  depth?: number;
  /** When true, runs the session-comm MCP server in --reply-only mode (suppresses outbound tools). Used for ask_session reply forks. */
  silent?: boolean;
  agents?: Record<string, { description: string; prompt: string; model?: string; tools?: string[]; maxTurns?: number }>;
  effort?: EffortLevel;
  mcpEnabled?: string[] | null;
  mcpExtra?: Record<string, unknown>;
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

/** State file written to data/users/{userId}/active-queries/{topic}.json while a query is running. */
export interface QueryState {
  task?: string;  // first 100 chars of prompt, newlines normalized
  since: string;  // ISO timestamp
}
