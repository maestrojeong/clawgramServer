import { readdirSync } from "fs";
import { join } from "path";
import TelegramBot from "node-telegram-bot-api";
import { bot } from "@/telegram/client";
import { logger } from "@/core/logger";
import { PROGRESS_DIR } from "@/core/config";
import { acquireJsonlLines, cleanupProcessing } from "@/telegram/outbox-utils";

export { PROGRESS_DIR };

// Track tool status message ID per topic (single, edit-in-place): key = `${forumGroupId}:${messageThreadId}`
const progressToolMsgId = new Map<string, number>();

export async function flushProgressOutbox() {
  let userDirs: string[];
  try { userDirs = readdirSync(PROGRESS_DIR); } catch { return; }

  for (const uid of userDirs) {
    const userDir = join(PROGRESS_DIR, uid);
    let files: string[];
    try { files = readdirSync(userDir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".processing")); }
    catch { continue; }

    for (const file of files) {
      const filePath = join(userDir, file);

      const lines = acquireJsonlLines(filePath, "progress-outbox");
      if (!lines) continue;
      cleanupProcessing(filePath);

      type ProgressEntry = { type: "status" | "log" | "clear"; forumGroupId: number; messageThreadId: number; text?: string };
      const entries: ProgressEntry[] = [];
      for (const line of lines) {
        try { entries.push(JSON.parse(line) as ProgressEntry); } catch {}
      }

      // Process status/log first, defer clear entries to avoid race condition
      // (ask_cron fork may write clear immediately after status in the same batch)
      const clearEntries: ProgressEntry[] = [];
      let hadStatusOrLog = false;

      for (const entry of entries) {
        if (entry.type === "clear") { clearEntries.push(entry); continue; }
        try {
          const key = `${entry.forumGroupId}:${entry.messageThreadId}`;
          const threadOpts: TelegramBot.SendMessageOptions = { message_thread_id: entry.messageThreadId };

          if (entry.type === "status" && entry.text) {
            hadStatusOrLog = true;
            const existingId = progressToolMsgId.get(key);
            if (existingId) {
              try {
                await bot.editMessageText(entry.text, {
                  chat_id: entry.forumGroupId,
                  message_id: existingId,
                });
              } catch (editErr) {
                const errMsg = editErr instanceof Error ? editErr.message : String(editErr);
                if (!errMsg.includes("message is not modified")) {
                  // Real failure: old message is gone, send a fresh one
                  progressToolMsgId.delete(key);
                  const sent = await bot.sendMessage(entry.forumGroupId, entry.text, threadOpts);
                  progressToolMsgId.set(key, sent.message_id);
                }
                // "message is not modified" → same text, keep existing ID as-is
              }
            } else {
              const sent = await bot.sendMessage(entry.forumGroupId, entry.text, threadOpts);
              progressToolMsgId.set(key, sent.message_id);
            }
          } else if (entry.type === "log" && entry.text) {
            hadStatusOrLog = true;
            await bot.sendMessage(entry.forumGroupId, entry.text, threadOpts);
          }
        } catch (e) {
          logger.warn({ err: e }, "progress-outbox: Failed to process entry");
        }
      }

      // Delay clear if it arrived in the same batch as status/log entries
      // so the user has time to see the tool status before it disappears
      if (clearEntries.length > 0) {
        if (hadStatusOrLog) await new Promise((r) => setTimeout(r, 1500));
        for (const entry of clearEntries) {
          try {
            const key = `${entry.forumGroupId}:${entry.messageThreadId}`;
            const existingId = progressToolMsgId.get(key);
            if (existingId) {
              await bot.deleteMessage(entry.forumGroupId, existingId).catch(() => {});
              progressToolMsgId.delete(key);
            }
          } catch (e) {
            logger.warn({ err: e }, "progress-outbox: Failed to process clear");
          }
        }
      }
    }
  }
}
