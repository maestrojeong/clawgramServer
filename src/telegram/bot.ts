import TelegramBot from "node-telegram-bot-api";
import { join } from "path";
import { bot, ADMIN_USERS } from "@/telegram/client";
import { sendMsg } from "@/telegram/helpers";
import { initUserWorkspace, syncMetaClaudeMd, syncMetaAgents, cleanStaleQueryStates } from "@/telegram/workspace";
import { buildPromptFromMessage, buildPromptFromMediaGroup } from "@/telegram/attachments";
import { handleClaudeQuery, activeQueries, AbortReason } from "@/telegram/query-handler";
import { handleDmCommand, handleForumConnect, handleForumFork, handleForumSpawn, handleForumNew } from "@/telegram/commands";
import { startOutboxPolling, onSessionInject, onAbortRequest } from "@/telegram/outbox";
import {
  findUserByGroupAndThread,
  findUserByGroupId,
  getAllTopicsForGroup,
  getCommunicateThreadId,
  getDmSessionId,
  getTopicDescription,
  getTopicModel,
  flushSessionCache,
  removeForumGroup,
} from "@/telegram/forum-sessions";
import { tryAutoConnectFromPromotion, tryAutoConnectFromMessage } from "@/telegram/auto-connect";
import { USERS_LOG_DIR, DM_SYSTEM_PROMPT, buildTopicSystemPrompt } from "@/core/config";
import { logger } from "@/core/logger";
import { killAllPlaywright } from "@/core/playwright/manager";

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
onSessionInject(async ({ userId, topicName, sessionId, prompt, messageThreadId, forumGroupId, from, depth, fromDepth, silent, requestId, contextId }) => {
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
    fromDepth,
    silent,
    requestId,
    contextId,
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

// --- my_chat_member: auto-connect on promotion, cleanup on kick ---
bot.on("my_chat_member", async (update: any) => {
  // Layer 1: auto-connect when bot is promoted to admin in a forum supergroup
  if (await tryAutoConnectFromPromotion(update)) return;

  const newStatus: string = update.new_chat_member?.status;
  const groupId: number = update.chat?.id;
  if (newStatus !== "kicked") return;
  if (!groupId) return;

  const userId = findUserByGroupId(groupId);
  if (userId === null) return;

  logger.warn({ userId, groupId }, "Bot removed from forum group, cleaning up");

  const topics = getAllTopicsForGroup(groupId);
  for (const topic of topics) {
    const queryKey = `${userId}:${topic.name}`;
    const running = activeQueries.get(queryKey);
    if (running) {
      running.abortReason = AbortReason.External;
      running.abortController.abort();
    }
  }

  removeForumGroup(userId, groupId);

  await sendMsg(
    userId,
    `⚠️ 봇이 그룹에서 제거되었습니다 (세션 ${topics.length}개 정리됨).\n다시 사용하려면 봇을 추가하고 관리자로 승격하세요 (자동 연결됩니다).`,
  ).catch((e) => logger.warn({ err: e, userId }, "my_chat_member: DM notify failed"));
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
    // Layer 2 auto-connect: bot was offline during promotion, catch up on first message
    if (isAdmin && await tryAutoConnectFromMessage(msg)) return;
    if (!msg.message_thread_id) return;

    const commThreadId = isAdmin ? getCommunicateThreadId(userId) : null;
    if (commThreadId && msg.message_thread_id === commThreadId) return;

    topicMatch = findUserByGroupAndThread(msg.chat.id, msg.message_thread_id);
    if (!topicMatch) return;

    // /fork, /spawn, /new must be handled before routeMessage so they don't inject into the Claude session.
    if (msg.text && isAdmin && await handleForumFork(msg)) return;
    if (msg.text && isAdmin && await handleForumSpawn(msg)) return;
    if (msg.text && isAdmin && await handleForumNew(msg)) return;
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
  await killAllPlaywright();
  await bot.stopPolling();
  process.exit(0);
}

process.on("SIGINT", () => cleanup().catch((e) => logger.error({ err: e }, "Cleanup failed")));
process.on("SIGTERM", () => cleanup().catch((e) => logger.error({ err: e }, "Cleanup failed")));
