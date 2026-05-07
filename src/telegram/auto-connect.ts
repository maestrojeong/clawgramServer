import type TelegramBot from "node-telegram-bot-api";
import { logger } from "@/core/logger";
import { ADMIN_USERS, bot } from "@/telegram/client";
import { addForumGroup, findUserByGroupId } from "@/telegram/forum-sessions";
import { sendMsg } from "@/telegram/helpers";

interface ForumChat {
  id: number;
  type: string;
  is_forum?: boolean;
  title?: string;
}

interface AdminMemberLike {
  status?: string;
  can_manage_topics?: boolean;
}

function botCanManageTopics(member: AdminMemberLike): boolean {
  if (member.status === "creator") return true;
  if (member.status === "administrator") return member.can_manage_topics === true;
  return false;
}

async function linkForumGroup(
  userId: number,
  groupId: number,
  title: string,
  canManageTopics: boolean,
  announce: boolean,
): Promise<void> {
  addForumGroup(userId, groupId, title);
  logger.info({ userId, groupId, title, canManageTopics, announce }, "Auto-connected forum group");
  if (!announce) return;

  const permissionWarning = canManageTopics
    ? ""
    : '\n\n⚠️ 봇에 "토픽 관리(Manage Topics)" 권한이 없어 토픽 생성/삭제가 불가합니다.\n그룹 관리 → 관리자 → 봇 → "토픽 관리" 권한을 켜주세요.';

  await sendMsg(
    groupId,
    `✅ "${title}" 그룹이 자동 연결되었습니다.\n/connect 없이 바로 사용하실 수 있습니다.${permissionWarning}`,
  ).catch((e) => logger.warn({ err: e, groupId }, "auto-connect: General announce failed"));

  await sendMsg(
    userId,
    `✅ 그룹 "${title}" (\`${groupId}\`) 이 자동 연결되었습니다.${permissionWarning}`,
  ).catch((e) => logger.warn({ err: e, userId }, "auto-connect: DM announce failed"));
}

/**
 * Layer 1: bot이 포럼 슈퍼그룹에서 관리자로 승격될 때 my_chat_member 이벤트로 자동 연결.
 * 승격한 사람이 허용 사용자일 때만 동작. 이미 연결된 그룹은 무시.
 */
export async function tryAutoConnectFromPromotion(update: {
  chat?: ForumChat;
  from?: { id?: number };
  new_chat_member?: AdminMemberLike;
}): Promise<boolean> {
  const chat = update.chat;
  const newMember = update.new_chat_member;
  const promoter = update.from?.id;
  if (!chat || chat.type !== "supergroup" || !chat.is_forum) return false;
  if (newMember?.status !== "administrator") return false;
  if (!promoter || !ADMIN_USERS.has(promoter)) return false;
  if (findUserByGroupId(chat.id) !== null) return false;

  await linkForumGroup(promoter, chat.id, chat.title ?? "", botCanManageTopics(newMember ?? {}), true);
  return true;
}

/**
 * Layer 2: 봇이 오프라인이었던 동안 승격된 경우를 위한 폴백.
 * 미등록 슈퍼그룹에서 메시지가 오면 bot+sender 관리자 여부를 확인 후 자동 연결.
 */
export async function tryAutoConnectFromMessage(msg: TelegramBot.Message): Promise<boolean> {
  const chat = msg.chat as ForumChat;
  const senderId = msg.from?.id;
  if (chat.type !== "supergroup" || !chat.is_forum) return false;
  if (!senderId || !ADMIN_USERS.has(senderId)) return false;
  if (findUserByGroupId(chat.id) !== null) return false;

  try {
    const botInfo = await bot.getMe();
    const botMember = (await bot.getChatMember(chat.id, botInfo.id)) as AdminMemberLike;
    if (botMember.status !== "administrator" && botMember.status !== "creator") return false;

    const senderMember = await bot.getChatMember(chat.id, senderId);
    if (senderMember.status !== "administrator" && senderMember.status !== "creator") return false;

    await linkForumGroup(senderId, chat.id, chat.title ?? "", botCanManageTopics(botMember), false);
    return true;
  } catch (e) {
    logger.debug({ err: e, groupId: chat.id, senderId }, "auto-connect lazy: getChatMember failed");
    return false;
  }
}
