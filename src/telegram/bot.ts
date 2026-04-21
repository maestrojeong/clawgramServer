import TelegramBot from "node-telegram-bot-api";
import { join } from "path";
import { bot, ADMIN_USERS } from "@/telegram/client";
import { sendMsg } from "@/telegram/helpers";
import { initUserWorkspace, syncMetaClaudeMd, syncMetaAgents, cleanStaleQueryStates } from "@/telegram/workspace";
import { buildPromptFromMessage, buildPromptFromMediaGroup } from "@/telegram/attachments";
import { handleClaudeQuery, activeQueries, AbortReason } from "@/telegram/query-handler";
import { handleDmCommand, handleForumConnect } from "@/telegram/commands";
import { startOutboxPolling, onSessionInject, onAbortRequest } from "@/telegram/outbox";
import {
  findUserByGroupAndThread,
  getCommunicateThreadId,
  getDmSessionId,
  getTopicDescription,
  getTopicModel,
  flushSessionCache,
} from "@/telegram/forum-sessions";
import { USERS_LOG_DIR, DM_SYSTEM_PROMPT, buildTopicSystemPrompt } from "@/core/config";
import { logger } from "@/core/logger";

// Fail fast if required env vars are missing
for (const key of ["WHISPER_BIN", "FFMPEG_BIN"] as const) {
  if (!process.env[key]) {
    logger.fatal(`${key} environment variable is not set`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Media Group Batching
// ---------------------------------------------------------------------------
const MEDIA_GROUP_WAIT_MS = 500;

interface MediaGroupEntry {
  messages: TelegramBot.Message[];
  timer: ReturnType<typeof setTimeout>;
  chatId: number;
  userId: number;
  topicMatch: ReturnType<typeof findUserByGroupAndThread>;
}

const mediaGroupBuffer = new Map<string, MediaGroupEntry>();

async function flushMediaGroup(mediaGroupId: string) {
  const entry = mediaGroupBuffer.get(mediaGroupId);
  if (!entry) return;
  mediaGroupBuffer.delete(mediaGroupId);

  const { messages, chatId, userId, topicMatch } = entry;
  logger.info(
    { mediaGroupId, messageCount: messages.length, userId },
    "Media group flush: processing batched messages as single prompt",
  );

  const text = await buildPromptFromMediaGroup(messages, chatId, userId);
  if (!text) {
    logger.warn({ mediaGroupId, userId }, "Media group flush: buildPromptFromMessages returned empty, skipping");
    const firstMsg = messages[0];
    const threadOpts = firstMsg.message_thread_id ? { message_thread_id: firstMsg.message_thread_id } : {};
    await sendMsg(chatId, "미디어 처리 실패: 첨부 파일을 읽을 수 없습니다.", threadOpts).catch(() => {});
    return;
  }

  await routeMessage(messages[0], chatId, userId, text, topicMatch);
}

/**
 * Routes a fully-built prompt to the correct handler (supergroup forum or DM).
 *
 * `topicMatch` is the supergroup topic lookup result already resolved by the caller
 * in bot.on. It is required (and non-null) for supergroup messages, and ignored
 * (`null`) for DMs. Passing it through avoids repeating the SQLite lookup here.
 */
async function routeMessage(
  msg: TelegramBot.Message,
  chatId: number,
  userId: number,
  text: string,
  topicMatch: ReturnType<typeof findUserByGroupAndThread>,
) {
  // --- Supergroup forum routing ---
  if (msg.chat.type === "supergroup") {
    if (!topicMatch || !msg.message_thread_id) return;

    const sender = msg.from;
    const senderLabel = sender
      ? (sender.username ? `@${sender.username}` : ([sender.first_name, sender.last_name].filter(Boolean).join(" ") || `id:${userId}`))
      : `id:${userId}`;
    const prompt = `[from: ${senderLabel} (id:${userId})]\n${text}`;

    await handleClaudeQuery({
      chatId: msg.chat.id,
      userId: topicMatch.userId,
      senderId: userId,
      topicName: topicMatch.topic.name,
      sessionId: topicMatch.topic.sessionId || null,
      prompt,
      messageThreadId: msg.message_thread_id,
      systemPrompt: buildTopicSystemPrompt({
        description: getTopicDescription(topicMatch.topic.name),
      }),
      model: getTopicModel(topicMatch.topic.name) || undefined,
      effort: topicMatch.topic.effort,
    });
    return;
  }

  // --- DM routing ---
  const handled = await handleDmCommand(chatId, userId, text);
  if (handled) return;

  const dmCwd = join(USERS_LOG_DIR, String(userId), "dm");

  await handleClaudeQuery({
    chatId,
    userId,
    senderId: userId,
    topicName: "__dm__",
    sessionId: getDmSessionId(userId),
    prompt: text,
    systemPrompt: DM_SYSTEM_PROMPT,
    cwd: dmCwd,
    sessionType: 'dm',
    model: "claude-sonnet-4-6",
  });
}

// --- Unhandled rejection guard (prevent process crash) ---
process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled rejection (bot stays alive)");
});

// --- Abort request callback ---
onAbortRequest((userId, topicName) => {
  const queryKey = `${userId}:${topicName}`;
  const running = activeQueries.get(queryKey);
  if (running) {
    running.abortReason = AbortReason.External;
    running.abortController.abort();
    return true;
  }
  return false;
});

// --- Session inject callback ---
onSessionInject(async ({ userId, topicName, sessionId, prompt, messageThreadId, forumGroupId, from, depth, chain, requestId, contextId, isCommand }) => {
  await handleClaudeQuery({
    chatId: forumGroupId,
    userId,
    topicName,
    sessionId,
    prompt,
    messageThreadId,
    systemPrompt: buildTopicSystemPrompt({
      description: getTopicDescription(topicName),
    }),
    from,
    depth,
    chain,
    requestId,
    contextId,
    isCommand,
  });
});

// --- Polling error handler ---
bot.on("polling_error", async (err: any) => {
  const statusCode = err?.response?.statusCode;
  logger.warn({ code: err?.code, status: statusCode }, "polling_error");

  if (statusCode === 429) {
    const retryAfter = (Number(err?.response?.body?.parameters?.retry_after) || 10) + 10;
    logger.warn({ retryAfter }, "polling: 429 rate limit, stopping polling");
    await bot.stopPolling();
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    logger.info("polling: resuming after rate limit wait");
    await bot.startPolling();
  }
});

// --- Sync meta agents and CLAUDE.md to all existing users at startup ---
syncMetaAgents();
syncMetaClaudeMd();

// --- Remove stale query state files left from crash ---
cleanStaleQueryStates();

// --- Start outbox polling ---
const stopOutboxPolling = startOutboxPolling();

// --- Handle messages ---
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  // Auth check
  if (!userId) return;
  const isAdmin = ADMIN_USERS.has(userId);

  // Bot-authored messages: never recurse on our own / other bots' output. We may
  // revisit this when cross-server session-comm via Telegram is implemented.
  if (msg.from?.is_bot) return;

  if (isAdmin) {
    initUserWorkspace(userId, msg.from);
  } else if (msg.chat.type === "private") {
    await sendMsg(chatId, `권한이 없습니다. (your id: ${userId})`);
    return;
  } else if (msg.chat.type !== "supergroup") {
    return;
  }

  // --- Supergroup: early checks before media group / single message handling ---
  let topicMatch: ReturnType<typeof findUserByGroupAndThread> = null;
  if (msg.chat.type === "supergroup") {
    if (isAdmin && await handleForumConnect(msg)) return;
    if (!msg.message_thread_id) return;

    const commThreadId = isAdmin ? getCommunicateThreadId(userId) : null;
    if (commThreadId && msg.message_thread_id === commThreadId) return;

    topicMatch = findUserByGroupAndThread(msg.chat.id, msg.message_thread_id);
    if (!topicMatch) return;
  } else if (msg.chat.type !== "private") {
    return;
  }

  // -----------------------------------------------------------------------
  // Media group batching
  // -----------------------------------------------------------------------
  const mediaGroupId = (msg as TelegramBot.Message & { media_group_id?: string }).media_group_id;

  if (mediaGroupId) {
    const existing = mediaGroupBuffer.get(mediaGroupId);

    if (existing) {
      existing.messages.push(msg);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => flushMediaGroup(mediaGroupId).catch((e) => logger.error({ err: e, mediaGroupId }, "flushMediaGroup failed")), MEDIA_GROUP_WAIT_MS);
    } else {
      mediaGroupBuffer.set(mediaGroupId, {
        messages: [msg],
        timer: setTimeout(() => flushMediaGroup(mediaGroupId).catch((e) => logger.error({ err: e, mediaGroupId }, "flushMediaGroup failed")), MEDIA_GROUP_WAIT_MS),
        chatId,
        userId,
        topicMatch,
      });
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Single message — process immediately
  // -----------------------------------------------------------------------
  const text = await buildPromptFromMessage(msg, chatId, userId);
  if (!text) return;

  await routeMessage(msg, chatId, userId, text, topicMatch);
});

// --- Cleanup on exit ---
async function cleanup() {
  logger.info("Shutting down...");
  activeQueries.forEach((q) => {
    q.abortReason = AbortReason.Internal;
    q.abortController.abort();
  });
  activeQueries.clear();
  stopOutboxPolling();
  flushSessionCache();
  await bot.stopPolling();
  process.exit(0);
}

process.on("SIGINT", () => cleanup().catch((e) => logger.error({ err: e }, "Cleanup failed")));
process.on("SIGTERM", () => cleanup().catch((e) => logger.error({ err: e }, "Cleanup failed")));
