export interface ForumTopic {
  message_thread_id: number;
  name: string;
}

export interface TelegramApiError {
  response?: { statusCode?: number };
}

// --- Session inject callback (registered by bot.ts to avoid circular dep) ---
export type SessionInjectHandler = (params: {
  userId: number;
  topicName: string;
  sessionId: string;
  prompt: string;
  messageThreadId: number;
  forumGroupId: number;
  from: string;
  /** Tell-chain depth for this session (0 = from user, 1+ = via tell_session). */
  depth: number;
  /** Caller's depth at ask_session time — restored when the silent fork's reply
   *  is injected back to the caller, so tell-chain caps remain accurate. */
  fromDepth?: number;
  /** When true, run as a silent ask_session reply fork (no visible output;
   *  result auto-injected to `from` topic; outbound MCP tools suppressed). */
  silent?: boolean;
  requestId?: string;
  contextId?: string;
}) => Promise<void>;

let _sessionInjectHandler: SessionInjectHandler | null = null;

export function onSessionInject(handler: SessionInjectHandler) {
  _sessionInjectHandler = handler;
}

export function getSessionInjectHandler(): SessionInjectHandler | null {
  return _sessionInjectHandler;
}

// --- Abort handler (registered by bot.ts to avoid circular dep) ---
export type AbortHandler = (userId: number, topicName: string) => boolean;

let _abortHandler: AbortHandler | null = null;

export function onAbortRequest(handler: AbortHandler) {
  _abortHandler = handler;
}

export function getAbortHandler(): AbortHandler | null {
  return _abortHandler;
}
