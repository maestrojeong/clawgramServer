import { bot } from "@/telegram/client";
import { removeTopic } from "@/telegram/forum-sessions";
import { clearQueryUsageAlert } from "@/core/session-alert";
import { logger } from "@/core/logger";

interface DeleteTopicParams {
  userId: number;
  topicName: string;
  sessionId: string | null;
  forumGroupId: number;
  messageThreadId: number;
}

export interface DeleteTopicResult {
  success: boolean;
  error?: string;
}

/**
 * Shared topic deletion: delete telegram topic → cleanup.
 */
export async function deleteTopicWithArchive(params: DeleteTopicParams): Promise<DeleteTopicResult> {
  const { userId, topicName, forumGroupId, messageThreadId } = params;

  // 1. Delete telegram topic
  try {
    await bot.closeForumTopic(forumGroupId, messageThreadId).catch(() => {});
    await bot.deleteForumTopic(forumGroupId, messageThreadId).catch(() => {});
  } catch {
    // Topic might already be deleted in Telegram, continue cleanup
  }

  // 2. Cleanup
  removeTopic(topicName);
  clearQueryUsageAlert(userId, topicName);

  return { success: true };
}
