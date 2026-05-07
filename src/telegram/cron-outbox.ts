import { appendFileSync, readdirSync } from "fs";
import { join } from "path";
import { sendMsg, splitMessage } from "@/telegram/helpers";
import { USERS_LOG_DIR } from "@/core/config";
import { getUserConfig, getTopicByName, setCronSessionForTopic } from "@/telegram/forum-sessions";
import { logger } from "@/core/logger";
import { acquireJsonlLines, cleanupProcessing } from "@/telegram/outbox-utils";

export async function flushCronOutbox() {
  let userDirs: string[];
  try {
    userDirs = readdirSync(USERS_LOG_DIR);
  } catch (e) {
    logger.warn({ err: e }, "cron-outbox: Failed to read users log dir");
    return;
  }

  for (const uid of userDirs) {
    const outboxDir = join(USERS_LOG_DIR, uid, "cron-outbox");
    const filePath = join(outboxDir, "pending.jsonl");

    const lines = acquireJsonlLines(filePath, "cron-outbox");
    if (!lines) continue;

    const MAX_RETRIES = 3;
    const failedLines: string[] = [];
    for (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        logger.error({ line }, "cron-outbox: Invalid JSON, dropping");
        continue;
      }

      const retryCount = (entry.retryCount as number | undefined) ?? 0;

      try {
        if (typeof entry.userId === "undefined" || typeof entry.topic !== "string" || !entry.topic) {
          logger.error({ entry }, "cron-outbox: Missing required fields (userId, topic), dropping");
          continue;
        }
        const userId = Number(entry.userId);
        if (isNaN(userId)) {
          logger.error({ entry }, "cron-outbox: Invalid userId, dropping");
          continue;
        }
        const topicName = entry.topic as string;
        const config = getUserConfig(userId);
        if (!config) {
          logger.error({ userId }, "cron-outbox: No config, dropping entry");
          continue;
        }

        const topic = getTopicByName(topicName);
        if (!topic) {
          logger.warn({ userId, topicName }, "cron-outbox: Topic not found, dropping entry");
          continue;
        }

        const threadOpts = { message_thread_id: topic.messageThreadId };

        // Update cronSessionId via cache (prevents overwrite race condition)
        if (entry.newCronSessionId) {
          setCronSessionForTopic(topicName, entry.newCronSessionId as string);
        }

        // Files are delivered via send_file MCP IPC during the cron run, not here.
        const text = `[cron: ${entry.cronName || "unknown"}]\n${entry.message}`;
        for (const chunk of splitMessage(text)) {
          await sendMsg(topic.forumGroupId, chunk, threadOpts);
        }
      } catch (err) {
        const nextRetry = retryCount + 1;
        if (nextRetry >= MAX_RETRIES) {
          logger.error({ err, entry, retryCount: nextRetry }, "cron-outbox: Max retries reached, dropping entry");
        } else {
          logger.warn({ err, retryCount: nextRetry }, "cron-outbox: Failed to post entry, will retry");
          failedLines.push(JSON.stringify({ ...entry, retryCount: nextRetry }));
        }
      }
    }

    cleanupProcessing(filePath);

    // Write back failed lines to pending.jsonl for retry on next poll
    if (failedLines.length > 0) {
      try {
        appendFileSync(filePath, failedLines.join("\n") + "\n");
      } catch (e) {
        logger.error({ err: e, count: failedLines.length }, "cron-outbox: Failed to write back entries");
      }
    }
  }
}
