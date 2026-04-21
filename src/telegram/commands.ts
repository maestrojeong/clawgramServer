import TelegramBot from "node-telegram-bot-api";
import { bot, ADMIN_USERS } from "@/telegram/client";
import { sendMsg } from "@/telegram/helpers";
import { toggleDebug } from "@/telegram/workspace";
import {
  getUserConfig,
  addForumGroup,
  removeForumGroup,
  addTopic,
  getTopicByName,
  getTopicNames,
  getTopicLink,
  getAllTopicsForGroup,
  updateTopicThreadId,
  clearDmSessionId,
  getForumGroupIds,
} from "@/telegram/forum-sessions";
import { logger } from "@/core/logger";
import { deleteTopicWithArchive } from "@/core/topic-lifecycle";
import { withTopicPrefix } from "@/core/config";

interface ForumTopic {
  message_thread_id: number;
  name: string;
  icon_color: number;
}

const START_MESSAGE =
  "📌 세션 안내\n\n" +
  "이 1:1 채팅에서 ��션 관리 및 일반 대화가 가능합니다.\n" +
  "각 세션은 포럼 그룹의 토픽으로 생성되며, 독립된 Claude 컨텍스트를 가집니다.\n\n" +
  "명령어:\n" +
  "/new <이름> — 새 세션(토픽) 생성\n" +
  "/new — 1:1 채팅 세션 초기화\n" +
  "/s — 세션 목록\n" +
  "/del <이름> — 세션 삭제\n" +
  "/connect — 포럼 그룹 연결\n" +
  "/disconnect <그룹ID> — 포럼 그룹 연결 해제\n" +
  "/debug — 디버그 모드 토글\n\n" +
  "여러 포럼 그룹을 동시에 연결할 수 있습니다.\n\n" +
  '처음이시면 "시작"이라고 말씀해주세요.';

/**
 * Handle DM commands. Returns true if a command was matched and handled.
 */
export async function handleDmCommand(chatId: number, userId: number, text: string): Promise<boolean> {
  if (text === "/start") {
    await sendMsg(chatId, START_MESSAGE);
    return true;
  }

  if (text === "/debug") {
    const isOn = toggleDebug(userId);
    await sendMsg(chatId, isOn
      ? "디버그 모드 ON — 중간 사고과정이 전송됩니다."
      : "디버그 모드 OFF — 중간 사고과정이 숨겨집니다.");
    return true;
  }

  if (text.startsWith("/connect")) {
    await handleConnectCommand(chatId, userId, text);
    return true;
  }

  if (text.startsWith("/disconnect")) {
    await handleDisconnectCommand(chatId, userId, text);
    return true;
  }

  if (text.startsWith("/new")) {
    await handleNewCommand(chatId, userId, text);
    return true;
  }

  if (text === "/s") {
    await handleListCommand(chatId, userId);
    return true;
  }

  if (text.startsWith("/del")) {
    await handleDelCommand(chatId, userId, text);
    return true;
  }

  return false;
}

// --- /connect ---
async function handleConnectCommand(chatId: number, userId: number, text: string): Promise<void> {
  const arg = text.split(/\s+/).slice(1).join(" ").trim();

  if (!arg) {
    const groupIds = getForumGroupIds(userId);
    if (groupIds.length > 0) {
      const config = getUserConfig(userId);
      const lines = groupIds.map((gid) => {
        const title = config?.forumGroupTitles[String(gid)] || gid;
        return `• ${title} (${gid})`;
      });
      await sendMsg(chatId,
        `연결된 그룹 (${groupIds.length}개):\n${lines.join("\n")}\n\n` +
        "추가 연결: /connect <그룹ID>\n" +
        "연결 해제: /disconnect <그룹ID>\n" +
        "또는 포럼 그룹에서 /connect 을 입력하세요."
      );
    } else {
      await sendMsg(chatId,
        "연결된 ���룹이 없습니다.\n\n" +
        "포럼 그룹에서 /connect 을 입력하거나\n" +
        "/connect <그룹ID> 로 연결하세요."
      );
    }
    return;
  }

  const groupId = Number(arg);
  if (isNaN(groupId)) {
    await sendMsg(chatId, "올바른 그룹 ID를 입력하세요. (예: /connect -1001234567890)");
    return;
  }

  await connectGroup(chatId, userId, groupId);
}

async function connectGroup(notifyChatId: number, userId: number, groupId: number): Promise<void> {
  try {
    const chatInfo = await bot.getChat(groupId);
    if (chatInfo.type !== "supergroup" || !(chatInfo as { is_forum?: boolean }).is_forum) {
      await sendMsg(notifyChatId, "이 그룹은 포럼이 활성화된 슈퍼그룹이 아닙니다.\n그룹 설정에서 토픽(Topics)을 켜주세요.");
      return;
    }

    const botInfo = await bot.getMe();
    const member = await bot.getChatMember(groupId, botInfo.id);
    if (member.status !== "administrator" && member.status !== "creator") {
      await sendMsg(notifyChatId, "봇이 이 그룹의 관리자가 아닙니다.\n봇을 관리자로 지정하고 '토픽 관리' 권한을 주세요.");
      return;
    }

    const isNew = addForumGroup(userId, groupId, chatInfo.title);

    if (isNew) {
      await sendMsg(notifyChatId,
        `✅ "${chatInfo.title}" 그룹이 연결되었습니다.\n\n` +
        "• /new <이름> 으로 세션을 만들 수 있습니다.\n" +
        "• /disconnect <그룹ID> 로 연결을 해제할 수 있습니다."
      );
    } else {
      await sendMsg(notifyChatId,
        `"${chatInfo.title}" 그룹은 이미 연결되어 있습니다.`
      );
      // Re-connect: check for stale topics
      await retryStaleTopics(userId, groupId, notifyChatId);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "unknown";
    await sendMsg(notifyChatId, `그룹 연결 실패: ${errMsg}\n\n봇이 해당 그룹의 멤버인지 확인하세요.`);
  }
}

// --- /disconnect ---
async function handleDisconnectCommand(chatId: number, userId: number, text: string): Promise<void> {
  const arg = text.split(/\s+/).slice(1).join(" ").trim();

  if (!arg) {
    const groupIds = getForumGroupIds(userId);
    if (groupIds.length === 0) {
      await sendMsg(chatId, "연결된 그룹이 없습니다.");
      return;
    }
    const config = getUserConfig(userId);
    const lines = groupIds.map((gid) => {
      const title = config?.forumGroupTitles[String(gid)] || gid;
      return `• ${title} — /disconnect ${gid}`;
    });
    await sendMsg(chatId, `연결 해제할 그룹 ID를 지정하세요:\n\n${lines.join("\n")}`);
    return;
  }

  const groupId = Number(arg);
  if (isNaN(groupId)) {
    await sendMsg(chatId, "올바른 그룹 ID를 입력하세요. (예: /disconnect -1001234567890)");
    return;
  }

  const removed = removeForumGroup(userId, groupId);
  if (removed) {
    await sendMsg(chatId, `✅ 그룹 연결이 해제되었습니다. (${groupId})\n해당 그룹의 토픽 데이터가 삭제되었습니다.`);
  } else {
    await sendMsg(chatId, `해당 그룹이 연결되어 있지 않습니다. (${groupId})`);
  }
}

// --- /new ---
async function handleNewCommand(chatId: number, userId: number, text: string): Promise<void> {
  const rawName = text.split(/\s+/).slice(1).join(" ").trim();
  if (!rawName) {
    clearDmSessionId(userId);
    await sendMsg(chatId, "1:1 채팅 세션을 초기화했습니다. 새로운 대화를 시작하세요!");
    return;
  }
  // User can pass either "foo" or "[srv] foo"; we always store with the prefix.
  const topicName = withTopicPrefix(rawName);

  const groupIds = getForumGroupIds(userId);
  if (groupIds.length === 0) {
    await sendMsg(chatId, "먼저 포럼 그룹을 연결하세요.\n/connect 로 시작하세요.");
    return;
  }

  const existing = getTopicByName(topicName);
  if (existing) {
    const link = getTopicLink(existing.forumGroupId, existing.messageThreadId);
    await sendMsg(chatId,
      `"${topicName}" 세션이 이미 있습니다.\n\n` +
      `바로가기: ${link}\n\n` +
      "세션을 초기화하려면 먼저 /del 로 삭제 후 다시 만드세요."
    );
    return;
  }

  // If multiple groups, use the first one (DM Claude session can specify group via MCP)
  const targetGroupId = groupIds[0];
  const config = getUserConfig(userId);
  const groupTitle = config?.forumGroupTitles[String(targetGroupId)] || "";

  try {
    const result = await bot.createForumTopic(targetGroupId, topicName) as unknown as ForumTopic;
    addTopic(userId, targetGroupId, topicName, result.message_thread_id);

    const link = getTopicLink(targetGroupId, result.message_thread_id);
    const groupNote = groupIds.length > 1 ? `\n그룹: ${groupTitle} (${targetGroupId})` : "";
    await sendMsg(chatId,
      `✅ "${topicName}" 세션을 생성했습니다.${groupNote}\n\n` +
      `바로가기: ${link}`
    );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "unknown";
    if (errMsg.includes("not enough rights") || errMsg.includes("CHAT_ADMIN_REQUIRED")) {
      await sendMsg(chatId,
        "❌ 봇이 그룹에서 토픽을 만들 권한이 없습니다.\n\n" +
        "봇을 관리자로 설정하고 '토픽 관리' 권한을 부여하세요."
      );
    } else {
      await sendMsg(chatId, `토픽 생성 실패: ${errMsg}`);
    }
  }
}

// --- /s ---
async function handleListCommand(chatId: number, userId: number): Promise<void> {
  const config = getUserConfig(userId);
  if (!config || config.forumGroupIds.length === 0) {
    await sendMsg(chatId, "먼저 포럼 그룹을 연결하세요.\n/connect 로 시작하세요.");
    return;
  }

  const allTopics = getTopicNames();
  if (allTopics.length === 0) {
    await sendMsg(chatId, "세션이 없습니다.\n/new <이름> 으로 생성하세요.");
    return;
  }

  const sections: string[] = [];
  for (const gid of config.forumGroupIds) {
    const title = config.forumGroupTitles[String(gid)] || gid;
    const topics = getAllTopicsForGroup(gid);
    if (topics.length === 0) continue;

    const lines = topics.map((t) => {
      const link = getTopicLink(gid, t.messageThreadId);
      const status = t.sessionId ? `(${t.sessionId.slice(0, 8)})` : "(새 세션)";
      return `  • ${t.name} ${status}\n    ${link}`;
    });

    sections.push(`📁 ${title}\n${lines.join("\n\n")}`);
  }

  await sendMsg(chatId,
    `세션 목록 (${allTopics.length}개):\n\n${sections.join("\n\n")}`
  );
}

// --- /del ---
async function handleDelCommand(chatId: number, userId: number, text: string): Promise<void> {
  const rawName = text.split(/\s+/).slice(1).join(" ").trim();
  if (!rawName) {
    await sendMsg(chatId, "사용법: /del <세션이름>");
    return;
  }
  const topicName = withTopicPrefix(rawName);

  const topic = getTopicByName(topicName);
  if (!topic) {
    await sendMsg(chatId, `"${topicName}" 세션을 찾을 수 없습니다.`);
    return;
  }

  const result = await deleteTopicWithArchive({
    userId,
    topicName,
    sessionId: topic.sessionId || null,
    forumGroupId: topic.forumGroupId,
    messageThreadId: topic.messageThreadId,
  });

  if (result.success) {
    await sendMsg(chatId, `"${topicName}" 세션 삭제됨.`);
  } else {
    await sendMsg(chatId, `"${topicName}" 삭제 실패: ${result.error}`);
  }
}


const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Build a human-readable result message for topic create/recovery operations. */
function buildTopicResultMsg(label: string, created: number, failedNames: string[]): string {
  let msg = `📋 ${label}: ${created}개`;
  if (failedNames.length > 0) {
    msg += `\n❌ ${failedNames.length}개 실패: ${failedNames.join(", ")}`;
  }
  return msg;
}

/** Create forum topics with retry + rate-limit delay. Returns [created, failedNames]. */
async function createTopicsWithRetry(
  userId: number, groupId: number, topics: { name: string }[], logTag: string,
): Promise<[number, string[]]> {
  let created = 0;
  const failedNames: string[] = [];

  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i];
    if (i > 0) await delay(500);

    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await delay(3000);
        const result = await bot.createForumTopic(groupId, topic.name) as unknown as ForumTopic;
        updateTopicThreadId(topic.name, result.message_thread_id, groupId);
        created++;
        success = true;
        logger.info({ userId, topicName: topic.name, newThreadId: result.message_thread_id }, `${logTag}: created`);
        break;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "unknown";
        logger.warn({ userId, topicName: topic.name, attempt: attempt + 1, error: errMsg }, `${logTag}: failed`);
      }
    }
    if (!success) failedNames.push(topic.name);
  }

  return [created, failedNames];
}

/**
 * Retry topics with stale thread_ids (when re-connecting to the same group).
 */
async function retryStaleTopics(userId: number, groupId: number, notifyChatId: number): Promise<void> {
  const topics = getAllTopicsForGroup(groupId);
  if (topics.length === 0) return;

  const staleTopics: typeof topics = [];

  for (const topic of topics) {
    let isStale = false;
    for (let probe = 0; probe < 2; probe++) {
      try {
        await bot.sendChatAction(groupId, "typing", { message_thread_id: topic.messageThreadId } as TelegramBot.SendChatActionOptions);
        isStale = false;
        break;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "";
        if (errMsg.includes("thread not found") || errMsg.includes("message thread")) {
          isStale = true;
          break;
        }
        if (probe >= 1) isStale = true;
        else await delay(1000);
      }
    }
    if (isStale) staleTopics.push(topic);
    await delay(200);
  }

  if (staleTopics.length === 0) {
    await sendMsg(notifyChatId, "✅ 모든 토픽이 정상입니다.");
    return;
  }

  await sendMsg(notifyChatId, `🔄 ${staleTopics.length}개 토픽 복구 시도 중...`);

  const [created, failedNames] = await createTopicsWithRetry(userId, groupId, staleTopics, "Recovery");
  await sendMsg(notifyChatId, buildTopicResultMsg("토픽 복구 성공", created, failedNames));
}

/** Handle /connect command from within a forum group */
export async function handleForumConnect(msg: TelegramBot.Message): Promise<boolean> {
  if (msg.chat.type !== "supergroup" || !(msg.chat as { is_forum?: boolean }).is_forum) return false;

  // General 토픽 (thread_id 없음)에서 /connect 외 메시지 → 안내
  if (!msg.message_thread_id && !msg.text?.startsWith("/connect")) {
    const userId = msg.from?.id;
    if (userId && ADMIN_USERS.has(userId)) {
      await sendMsg(msg.chat.id,
        "이 General 토픽은 /connect 전용입니다.\n" +
        "대화는 세션 토픽에서, 세션 관리는 1:1 채팅에서 해주세요.");
    }
    return true;
  }

  if (!msg.text?.startsWith("/connect")) return false;

  const userId = msg.from?.id;
  if (!userId || !ADMIN_USERS.has(userId)) return false;

  const groupId = msg.chat.id;
  const title = msg.chat.title || "";

  try {
    const isNew = addForumGroup(userId, groupId, title);

    const threadOpts: TelegramBot.SendMessageOptions = msg.message_thread_id
      ? { message_thread_id: msg.message_thread_id } : {};

    if (isNew) {
      await sendMsg(groupId,
        `✅ "${title}" 그룹이 연결되었습니다.\n` +
        `그룹 ID: \`${groupId}\`\n\n` +
        "• 이 General 토픽은 /connect 전용입니다.\n" +
        "• 새 세션: 1:1 채팅에서 /new <토픽명> 또는 직접 요청", threadOpts);
    } else {
      await sendMsg(groupId,
        `이 그룹은 이미 연결되어 있습니다.\n그룹 ID: \`${groupId}\``, threadOpts);
      await retryStaleTopics(userId, groupId, groupId);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logger.error({ userId, groupId, error: errMsg }, "Forum /connect failed");
    await sendMsg(groupId, `연결 실패: ${errMsg}\n그룹 ID: \`${groupId}\``).catch(() => {});
  }

  return true;
}
