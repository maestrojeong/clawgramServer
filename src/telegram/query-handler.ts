import TelegramBot from "node-telegram-bot-api";
import { mkdirSync, readFileSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { bot } from "@/telegram/client";
import { sendMsg, sendHtmlMsg, splitMessage, sendSplitMsg } from "@/telegram/helpers";
import { writeLog } from "@/telegram/logging";
import { isDebug, writeQueryState, clearQueryState } from "@/telegram/workspace";
import { runAgent, FALLBACK_AGENT } from "@/core/agents";
import { ensurePlaywright } from "@/core/playwright/manager";
import { formatToolUse } from "@/core/agents/tool-format";
import type { TokenUsage, EffortLevel, AgentKind } from "@/core/types";
import { logger } from "@/core/logger";
import { homedir } from "os";
import { USERS_LOG_DIR } from "@/core/config";

const HOME_DIR = homedir();
const EXTRA_ALLOWED_CWD_PREFIXES: string[] = (process.env.ALLOWED_CWD_PREFIXES || "")
  .split(",")
  .map(p => p.trim())
  .filter(Boolean);

function expandHome(p: string | null): string | null {
  if (!p) return null;
  if (p === "~") return HOME_DIR;
  if (p.startsWith("~/")) return join(HOME_DIR, p.slice(2));
  return p;
}
import {
  getSessionForTopic,
  setSessionForTopic,
  clearSessionForTopic,
  setDmSessionId,
  clearDmSessionId,
  getTopicByName,
  getTopicMcpConfig,
  getTopicDescription,
  getTopicCwd,
  getTopicAgent,
  getLastShownConfig,
  setLastShownConfig,
} from "@/telegram/forum-sessions";
import { getRegistry } from "@/core/agents/registry";
import { buildTopicSystemPrompt } from "@/core/config";
import { recordUsage } from "@/core/token-stats";
import { checkQueryUsageAlert } from "@/core/session-alert";
import { appendContext } from "@/core/context-store";

// --- Sensitive path blacklist ---
const SENSITIVE_PATH_PATTERNS = [
  /\/\.env(\.|$)/i,
  /\/\.ssh\//i,
  /\/\.aws\//i,
  /\/\.gnupg\//i,
  /\/\.netrc$/i,
  /\/\.npmrc$/i,
  /\/(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|cer|crt)$/i,
  /\/Library\/Keychains\//i,
];

export function isSensitivePath(filePath: string): boolean {
  const normalized = resolve(filePath);
  if (SENSITIVE_PATH_PATTERNS.some((p) => p.test(normalized))) return true;
  try {
    const real = realpathSync(normalized);
    if (real !== normalized) return SENSITIVE_PATH_PATTERNS.some((p) => p.test(real));
  } catch {
    // File doesn't exist — no symlink concern
  }
  return false;
}

// --- Footer helpers ---

function attachFooterToChunks(chunks: string[], footer: string | null, limit = 4096): string[] {
  if (!footer || chunks.length === 0) return chunks;
  const last = chunks[chunks.length - 1];
  const combined = `${last}\n\n${footer}`;
  if (combined.length <= limit) chunks[chunks.length - 1] = combined;
  else chunks.push(footer);
  return chunks;
}

function buildConfigFooter(topicName: string, sessionType: string | undefined): string | null {
  if (sessionType === "dm") return null;
  const topic = getTopicByName(topicName);
  if (!topic) return null;
  const agent = topic.agent;
  const registry = getRegistry(agent);
  const model = topic.model ?? registry.defaultModel;
  const effort = topic.effort ?? registry.defaultEffort;
  const last = getLastShownConfig(topicName);
  if (last && last.agent === agent && last.model === model && (last.effort ?? undefined) === effort) {
    return null;
  }
  setLastShownConfig(topicName, agent, model, effort);
  return `*${agent} · ${registry.footerLabel(model, effort)}*`;
}

// --- cwd validation ---
const BLOCKED_CWD_PREFIXES = ["/etc", "/var", "/System", "/Library", "/usr", "/sbin", "/bin", "/private/etc", "/private/var"];

function isAllowedCwd(cwd: string): boolean {
  const resolved = resolve(cwd);
  // Block system-critical directories
  for (const prefix of BLOCKED_CWD_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(prefix + "/")) return false;
  }
  // Must be under home directory, USERS_LOG_DIR, or extra allowed prefixes
  if (resolved.startsWith(HOME_DIR + "/") || resolved === HOME_DIR
    || resolved.startsWith(USERS_LOG_DIR + "/") || resolved === USERS_LOG_DIR) return true;
  for (const prefix of EXTRA_ALLOWED_CWD_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(prefix + "/")) return true;
  }
  return false;
}

// --- Parameter interfaces ---

interface BaseQueryParams {
  chatId: number;
  userId: number;
  topicName: string;
  sessionId: string | null;
  prompt: string;
  senderId?: number;
}

interface OutputParams {
  messageThreadId?: number;
  systemPrompt?: string;
  cwd?: string;
  sessionType?: "dm" | "forum";
  model?: string;
  silent?: boolean;
  effort?: EffortLevel;
  /** Override agent (default: loaded from DB for forum topics, 'claude' for DM). */
  agent?: AgentKind;
}

interface SessionChainParams {
  from?: string;
  /** Tell-chain depth for this session (0 = from user, 1+ = via tell_session). */
  depth?: number;
  /** Caller's depth at ask_session time — used to restore the caller's depth
   *  when a silent fork's reply is injected back. */
  fromDepth?: number;
  requestId?: string;
  contextId?: string;
  agents?: Record<string, { description: string; prompt: string; model?: string; tools?: string[]; maxTurns?: number }>;
}

interface RetryGuardParams {
  _sessionRetried?: boolean;
}

export interface HandleClaudeQueryParams
  extends BaseQueryParams, OutputParams, SessionChainParams, RetryGuardParams {}

// --- Abort reason ---

export enum AbortReason {
  None     = "none",
  Internal = "internal",
  External = "external",
}

// --- Active queries (userId:topicName → abort control) ---

export const activeQueries = new Map<string, {
  abortReason: AbortReason;
  userId: number;
  senderId?: number;
  abortController: AbortController;
  params?: HandleClaudeQueryParams;
}>();

// --- Inter-session queue: defers inject requests while a query is running ---

class SessionInjectQueue {
  private queue = new Map<string, HandleClaudeQueryParams[]>();

  enqueue(queryKey: string, params: HandleClaudeQueryParams, logReason: string): boolean {
    if (!params.requestId) {
      logger.warn({ queryKey, from: params.from }, "Session inject has no requestId, skipping queue");
      return false;
    }
    const q = this.queue.get(queryKey) ?? [];
    if (q.some((p) => p.requestId === params.requestId)) return false;
    q.push(params);
    this.queue.set(queryKey, q);
    logger.info({ queryKey, from: params.from, requestId: params.requestId }, logReason);
    return true;
  }

  dequeueNext(queryKey: string): HandleClaudeQueryParams | undefined {
    const q = this.queue.get(queryKey);
    if (!q?.length) return undefined;
    const next = q.shift()!;
    if (q.length === 0) this.queue.delete(queryKey);
    return next;
  }
}

// --- User message queue: defers messages from different senders on the same topic ---

class UserMessageQueue {
  private queue = new Map<string, HandleClaudeQueryParams[]>();

  enqueue(queryKey: string, params: HandleClaudeQueryParams): void {
    const q = this.queue.get(queryKey) ?? [];
    q.push(params);
    this.queue.set(queryKey, q);
    logger.info({ queryKey, senderId: params.senderId }, "User message queued: different sender on busy topic");
  }

  dequeueNext(queryKey: string): HandleClaudeQueryParams | undefined {
    const q = this.queue.get(queryKey);
    if (!q?.length) return undefined;
    const next = q.shift()!;
    if (q.length === 0) this.queue.delete(queryKey);
    return next;
  }
}

const userMessageQueue = new UserMessageQueue();

const interSessionQueue = new SessionInjectQueue();

// --- DM session retry guard ---
const dmRetryingUsers = new Set<number>();

const SESSION_EXPIRED_MSG = "No conversation found with session ID";

function detectSessionExpiry(
  params: HandleClaudeQueryParams,
  errMsg: string,
  userId: number,
  topicName: string,
): "dm-retry" | "forum-retry" | null {
  if (params._sessionRetried || !errMsg.includes(SESSION_EXPIRED_MSG)) return null;

  if (params.sessionType === "dm") {
    if (!dmRetryingUsers.has(userId)) {
      clearDmSessionId(userId);
      dmRetryingUsers.add(userId);
      logger.info({ userId }, "DM session expired, cleared and will retry");
      return "dm-retry";
    }
  } else {
    clearSessionForTopic(topicName);
    logger.info({ userId, topicName }, "Forum session expired, cleared and will retry");
    return "forum-retry";
  }
  return null;
}

// --- Shared Claude query handler ---

export async function handleClaudeQuery(params: HandleClaudeQueryParams) {
  const { chatId, userId, topicName, sessionId, prompt, messageThreadId } = params;
  const queryKey = `${userId}:${topicName}`;

  const threadOpts: TelegramBot.SendMessageOptions = messageThreadId ? { message_thread_id: messageThreadId } : {};

  // Per-user concurrent query limit
  const MAX_CONCURRENT_PER_USER = 10;
  const userActiveCount = [...activeQueries.values()].filter((q) => q.userId === userId).length;
  if (userActiveCount >= MAX_CONCURRENT_PER_USER) {
    if (!params.silent) {
      await sendMsg(chatId, "처리 중인 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.", threadOpts).catch(() => {});
    }
    return;
  }

  async function sendToThread(text: string, extraOpts?: TelegramBot.SendMessageOptions) {
    if (params.silent) return;
    await sendHtmlMsg(chatId, text, { ...threadOpts, ...extraOpts });
  }

  // Same topic → abort previous query, with priority: user > session inject
  // Multi-user: only abort if same sender; different sender → queue
  const incomingSenderId = params.senderId;
  const runningOnThis = activeQueries.get(queryKey);
  if (runningOnThis) {
    const incomingIsSession = params.from && params.from !== "user";
    const runningIsUser = !runningOnThis.params?.from || runningOnThis.params.from === "user";

    if (incomingIsSession && runningIsUser) {
      interSessionQueue.enqueue(queryKey, params, "Session inject deferred: user query running");
      return;
    }

    if (incomingIsSession && !runningIsUser) {
      interSessionQueue.enqueue(queryKey, params, "Session inject queued: another session inject running");
      return;
    }

    // Different sender on same topic → queue instead of abort
    if (incomingSenderId && runningOnThis.senderId && incomingSenderId !== runningOnThis.senderId) {
      userMessageQueue.enqueue(queryKey, params);
      return;
    }

    // Same sender (or no sender info) → abort previous
    if (runningOnThis.params?.from && runningOnThis.params.from !== "user") {
      interSessionQueue.enqueue(queryKey, runningOnThis.params, "Inter-session query aborted by user, re-queued for later");
    }
    runningOnThis.abortReason = AbortReason.Internal;
    runningOnThis.abortController.abort();
  }

  const abortController = new AbortController();
  const control = { abortReason: AbortReason.None, userId, senderId: incomingSenderId, abortController, params };
  activeQueries.set(queryKey, control);

  const silent = !!params.silent;

  const chatActionOpts: TelegramBot.SendChatActionOptions = messageThreadId ? { message_thread_id: messageThreadId } : {};
  if (!silent) {
    bot.sendChatAction(chatId, "typing", chatActionOpts).catch(() => {});
  }
  const typingInterval = setInterval(() => {
    if (control.abortReason !== AbortReason.None) return clearInterval(typingInterval);
    if (!silent) bot.sendChatAction(chatId, "typing", chatActionOpts).catch(() => {});
  }, 4000);

  writeQueryState(userId, topicName, prompt);

  let pendingInject: {
    params: Parameters<typeof handleClaudeQuery>[0];
    errorChatId: number;
    errorThreadId: number;
  } | null = null;
  let pendingDmRetry = false;
  let pendingForumRetry = false;

  // --- Tool status message (temporary, editable) ---
  let toolStatusMsgId: number | null = null;

  async function showToolStatus(text: string) {
    if (silent) return;
    try {
      if (toolStatusMsgId) {
        await bot.editMessageText(text, { chat_id: chatId, message_id: toolStatusMsgId });
      } else {
        const msgOpts: TelegramBot.SendMessageOptions = messageThreadId ? { message_thread_id: messageThreadId } : {};
        const sent = await bot.sendMessage(chatId, text, msgOpts);
        toolStatusMsgId = sent.message_id;
      }
    } catch {
      // Edit/send can fail if message was already deleted, ignore
    }
  }

  async function clearToolStatus() {
    if (!toolStatusMsgId) return;
    const msgId = toolStatusMsgId;
    toolStatusMsgId = null;
    try {
      await bot.deleteMessage(chatId, msgId);
    } catch {
      // Already deleted or too old, ignore
    }
  }

  try {
    const topicCwd = params.sessionType !== "dm"
      ? getTopicCwd(topicName)
      : null;
    const rawCwd = expandHome(params.cwd ?? null) || expandHome(topicCwd) || homedir();
    const userCwd = isAllowedCwd(rawCwd) ? rawCwd : homedir();
    if (rawCwd !== userCwd) {
      logger.warn({ userId, topicName, requestedCwd: rawCwd, fallbackCwd: userCwd }, "Blocked disallowed cwd, falling back to homedir");
    }
    mkdirSync(userCwd, { recursive: true });

    const mcpConfig =
      params.sessionType !== "dm"
        ? getTopicMcpConfig(topicName)
        : { enabled: null, extra: {} };

    // Load agent: explicit override > DB value for forum topics > fallback
    const agent: AgentKind =
      params.agent ??
      (params.sessionType !== "dm"
        ? getTopicAgent(topicName)
        : FALLBACK_AGENT);

    // Spawn a Playwright MCP SSE server for this (user, topic) — only if the
    // topic actually wants it. DM always gets it; forum topics opt-in via
    // mcpEnabled. Falling back to stdio (no port) keeps the MCP config valid
    // even if spawn fails.
    const wantsPlaywright =
      params.sessionType === "dm" ||
      (mcpConfig.enabled?.includes("playwright") ?? false);
    let playwrightPort: number | undefined;
    if (wantsPlaywright) {
      try {
        playwrightPort = await ensurePlaywright(String(userId), topicName);
      } catch (e) {
        logger.warn({ err: e, userId, topicName }, "ensurePlaywright failed, falling back to stdio");
      }
    }

    let textBuffer = "";
    let lastPreToolText = "";
    let finalResponse = "";
    let resultSent = false;
    let finalUsage: TokenUsage | undefined;
    let currentSessionId: string | null = sessionId;
    const debug = isDebug(userId);

    async function flushText() {
      if (!textBuffer.trim()) return;
      let toSend = textBuffer.trim();
      textBuffer = "";
      if (silent) return;
      await clearToolStatus();
      for (const chunk of splitMessage(toSend)) {
        await sendToThread(chunk);
      }
    }

    for await (const event of runAgent({
      agent,
      prompt,
      sessionId: sessionId || undefined,
      cwd: userCwd,
      userId: String(userId),
      session: topicName,
      systemPrompt: params.systemPrompt ?? "",
      sessionType: params.sessionType,
      abortController,
      model: params.model,
      depth: params.depth ?? 0,
      silent,
      agents: params.agents,
      effort: params.effort,
      mcpEnabled: mcpConfig.enabled,
      mcpExtra: mcpConfig.extra,
      playwrightPort,
    })) {
      if (control.abortReason !== AbortReason.None) break;

      switch (event.type) {
        case "user_message":
          break;

        case "session":
          currentSessionId = event.sessionId;
          if (params.sessionType === "dm") {
            setDmSessionId(userId, event.sessionId);
          } else if (!silent) {
            setSessionForTopic(topicName, event.sessionId);
          }
          break;

        case "tool_use":
          if (debug) {
            await flushText();
          } else {
            if (textBuffer.trim()) lastPreToolText = textBuffer.trim();
            textBuffer = "";
          }
          if (!silent && event.name) {
            const label = formatToolUse(event.name, event.input || {});
            await showToolStatus(`🔧 ${label}`);
          }
          break;

        case "tool_progress":
          break;

        case "tool_use_summary":
          if (debug) {
            await flushText();
            await sendToThread(event.summary);
          } else {
            textBuffer = "";
          }
          break;

        case "tool_result":
          break;

        case "text_delta":
          if (!resultSent) textBuffer += event.content;
          break;

        case "text":
          if (!resultSent) textBuffer = event.content;
          break;

        case "result": {
          resultSent = true;
          textBuffer = "";
          await clearToolStatus();
          finalUsage = event.usage;
          if (event.content && event.content.trim()) {
            const clean = event.content.trim();
            if (clean) {
              finalResponse = clean;
              if (!silent) {
                const footer = buildConfigFooter(topicName, params.sessionType);
                const chunks = attachFooterToChunks(splitMessage(clean), footer);
                for (const chunk of chunks) {
                  await sendToThread(chunk);
                }
              }
            }
          }
          break;
        }

        case "error":
          if (!silent) await sendToThread(`Error: ${event.content}`);
          break;
      }
    }

    // If no result was sent, flush remaining text or fall back to last pre-tool text
    if (!resultSent) {
      if (textBuffer.trim()) {
        finalResponse = textBuffer.trim();
        await flushText();
      } else if (lastPreToolText) {
        finalResponse = lastPreToolText;
        if (!silent) {
          for (const chunk of splitMessage(lastPreToolText)) {
            await sendToThread(chunk);
          }
        }
      }
    } else if (debug) {
      await flushText();
    }

    writeLog({
      timestamp: new Date().toISOString(),
      userId,
      sessionId: getSessionForTopic(topicName) || null,
      session: topicName,
      prompt,
      response: finalResponse,
      usage: finalUsage,
    });
    if (finalUsage) {
      logger.info({
        userId,
        session: topicName,
        inputTokens: finalUsage.inputTokens,
        outputTokens: finalUsage.outputTokens,
        cacheCreationInputTokens: finalUsage.cacheCreationInputTokens,
        cacheReadInputTokens: finalUsage.cacheReadInputTokens,
      }, "Claude token usage");
      recordUsage(userId, topicName, finalUsage);
      if (params.sessionType !== "dm" && !silent) {
        checkQueryUsageAlert(userId, topicName, finalUsage);
      }
    }

    // Save response to context store
    if (params.contextId && finalResponse && control.abortReason === AbortReason.None) {
      appendContext(userId, params.contextId, { role: topicName, content: finalResponse, ts: new Date().toISOString() });
    }

    // Prepare inject params — fired in finally after activeQueries cleanup.
    // Only silent ask_session reply forks (silent=true with a sender) inject back to sender.
    const senderName = params.from;
    if (senderName && senderName !== "user" && silent && control.abortReason === AbortReason.None && finalResponse) {
      const senderTopic = getTopicByName(senderName);
      if (senderTopic?.sessionId) {
        const injectPrompt = `[${topicName} 세션에서 공유됨]\n${finalResponse}`;
        await sendSplitMsg(senderTopic.forumGroupId, `[← ${topicName}]\n${finalResponse}`, { message_thread_id: senderTopic.messageThreadId }).catch(
          (e) => logger.warn({ err: e }, "ask_session: failed to send response to sender topic")
        );
        pendingInject = {
          params: {
            chatId: senderTopic.forumGroupId,
            userId,
            topicName: senderName,
            sessionId: senderTopic.sessionId,
            prompt: injectPrompt,
            messageThreadId: senderTopic.messageThreadId,
            systemPrompt: buildTopicSystemPrompt({
              description: getTopicDescription(senderName),
            }),
            from: topicName,
            // Resume caller at the depth it was at when it called ask_session,
            // so subsequent tell_session depth checks remain accurate.
            depth: params.fromDepth ?? 0,
          },
          errorChatId: senderTopic.forumGroupId,
          errorThreadId: senderTopic.messageThreadId,
        };
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";

    const expiryRetry = detectSessionExpiry(params, errMsg, userId, topicName);
    if (expiryRetry === "dm-retry") {
      pendingDmRetry = true;
    } else if (expiryRetry === "forum-retry") {
      pendingForumRetry = true;
    } else if (control.abortReason === AbortReason.None && !params.silent) {
      await sendMsg(chatId, `Error: ${errMsg}`, threadOpts).catch((e) =>
        logger.error({ err: e }, "Failed to send error message")
      );
    }
  } finally {
    clearInterval(typingInterval);
    if (toolStatusMsgId) {
      bot.deleteMessage(chatId, toolStatusMsgId).catch(() => {});
      toolStatusMsgId = null;
    }
    if (activeQueries.get(queryKey) === control) {
      activeQueries.delete(queryKey);
      clearQueryState(userId, topicName);
    }

    // If externally aborted while processing a silent ask reply, notify sender
    const senderName = params.from;
    if (control.abortReason === AbortReason.External && senderName && senderName !== "user" && silent && !pendingInject) {
      const senderTopic = getTopicByName(senderName);
      if (senderTopic) {
        sendMsg(senderTopic.forumGroupId, `[← ${topicName}]\n(abort됨: 외부 중단 요청으로 응답을 받을 수 없습니다)`, {
          message_thread_id: senderTopic.messageThreadId,
        }).catch((e) => logger.error({ err: e }, "Failed to notify sender of aborted session"));
      }
    }

    // Fire inject AFTER activeQueries cleanup
    if (pendingInject) {
      const { params: injectParams, errorChatId, errorThreadId } = pendingInject;
      logger.info({ userId, from: topicName, to: injectParams.topicName, depth: injectParams.depth }, "Injecting reply back to sender");
      handleClaudeQuery(injectParams).catch((e) => {
        logger.error({ err: e }, "Failed to inject reply to sender");
        const errMsg = e instanceof Error ? e.message : "Unknown error";
        sendMsg(errorChatId, `[${topicName} → ${injectParams.topicName}] 세션 응답 전달 실패: ${errMsg}`, { message_thread_id: errorThreadId }).catch(() => {});
      });
    }

    // Retry with fresh session after expiry
    if (pendingDmRetry) {
      handleClaudeQuery({ ...params, sessionId: null, _sessionRetried: true })
        .finally(() => dmRetryingUsers.delete(userId))
        .catch((e) => logger.error({ err: e }, "Failed to retry DM query after session expiry"));
    }
    if (pendingForumRetry) {
      handleClaudeQuery({ ...params, sessionId: null, _sessionRetried: true })
        .catch((e) => logger.error({ err: e }, "Failed to retry forum query after session expiry"));
    }

    // Re-execute next queued inter-session request
    const next = interSessionQueue.dequeueNext(queryKey);
    if (next) {
      logger.info({ queryKey, from: next.from }, "Re-executing queued inter-session query");
      handleClaudeQuery(next).catch((e) =>
        logger.error({ err: e, queryKey }, "Failed to re-execute queued inter-session query")
      );
    } else {
      // Re-execute next queued user message (from different sender)
      const nextUser = userMessageQueue.dequeueNext(queryKey);
      if (nextUser) {
        logger.info({ queryKey, senderId: nextUser.senderId }, "Re-executing queued user message");
        handleClaudeQuery(nextUser).catch((e) =>
          logger.error({ err: e, queryKey }, "Failed to re-execute queued user message")
        );
      }
    }
  }
}
