import { writeFileSync, appendFileSync, readdirSync, renameSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { bot } from "@/telegram/client";
import {
  getUserConfig,
  getTopicByName,
  addTopic,
  getTopicLink,
  setTopicDescription,
  setTopicModel,
  setTopicEffort,
  setTopicCwd,
  getTopicCwd,
  setTopicMcpEnabled,
  setTopicMcpExtra,
  setTopicAgent,
} from "@/telegram/forum-sessions";
import type { AgentKind } from "@/core/types";
import { logger } from "@/core/logger";
import type { EffortLevel } from "@/core/types";
import { DM_CMD_DIR, DM_RESP_DIR, withTopicPrefix } from "@/core/config";
import { ForumTopic, getSessionInjectHandler } from "@/telegram/outbox-types";
import { deleteTopicWithArchive } from "@/core/topic-lifecycle";
import { acquireJsonlLines, cleanupProcessing } from "@/telegram/outbox-utils";
import { sendFileToChat } from "@/telegram/helpers";
import { isSensitivePath } from "@/telegram/query-handler";

export { DM_CMD_DIR };

/** Atomically write a response file (tmp + rename) to prevent partial reads by MCP pollers. */
function writeResponse(respFile: string, data: object) {
  const tmp = respFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, respFile);
}

const HOME_DIR = homedir();
const BLOCKED_PATH_PREFIXES = ["/etc", "/var", "/System", "/Library", "/usr", "/sbin", "/bin", "/private/etc", "/private/var"];

/** Resolve a path through symlinks; falls back to plain resolve if file doesn't exist. */
function resolveReal(p: string): string {
  const r = resolve(p);
  try { return realpathSync(r); } catch { return r; }
}

/** Returns true if `filePath` is allowed to be sent for the given topic.
 *  - Forum topic with cwd: must live inside topic's cwd.
 *  - DM or topic without cwd: must live inside HOME (and not under system-critical dirs). */
function isFileAllowedForTopic(filePath: string, topic: string): { ok: true } | { ok: false; reason: string } {
  if (isSensitivePath(filePath)) return { ok: false, reason: "Sensitive path blocked (env/keys/credentials)" };
  const real = resolveReal(filePath);
  for (const prefix of BLOCKED_PATH_PREFIXES) {
    if (real === prefix || real.startsWith(prefix + "/")) {
      return { ok: false, reason: `Path under blocked prefix ${prefix}` };
    }
  }
  if (topic !== "dm") {
    const topicCwd = getTopicCwd(topic);
    if (topicCwd) {
      const cwdReal = resolveReal(topicCwd);
      if (real !== cwdReal && !real.startsWith(cwdReal + "/")) {
        return { ok: false, reason: `File must be inside topic cwd: ${cwdReal}` };
      }
      return { ok: true };
    }
  }
  if (real === HOME_DIR || real.startsWith(HOME_DIR + "/")) return { ok: true };
  return { ok: false, reason: "File must be inside the user's home directory" };
}

export async function flushDmCommands() {
  let files: string[];
  try {
    files = readdirSync(DM_CMD_DIR).filter((f) => f.endsWith(".jsonl"));
  } catch (e) {
    logger.warn({ err: e }, "dm-commands: Failed to read command dir");
    return;
  }

  for (const file of files) {
    const filePath = join(DM_CMD_DIR, file);

    const lines = acquireJsonlLines(filePath, "dm-commands");
    if (!lines) continue;

    const remaining: string[] = [];
    for (const line of lines) {
      try {
        const cmd = JSON.parse(line);
        if (!cmd.action || typeof cmd.action !== "string" || !cmd.requestId) {
          logger.error({ cmd }, "dm-commands: Missing action or requestId, dropping");
          continue;
        }
        const uid = Number(file.replace(".jsonl", ""));
        const config = getUserConfig(uid);
        const respFile = join(DM_RESP_DIR, `${uid}-${cmd.requestId}.json`);

        if (cmd.action === "create_topic") {
          if (!config || config.forumGroupIds.length === 0) {
            writeResponse(respFile, { success: false, error: "No forum group linked" });
            continue;
          }
          // Use group_id from params if specified, otherwise first group
          const targetGroupId = cmd.params.group_id ? Number(cmd.params.group_id) : config.forumGroupIds[0];
          if (!config.forumGroupIds.includes(targetGroupId)) {
            writeResponse(respFile, { success: false, error: `Group ${targetGroupId} is not connected` });
            continue;
          }
          try {
            // Auto-prefix with this server's [SERVER_NAME]
            const topicName = withTopicPrefix(cmd.params.name as string);
            const result = await bot.createForumTopic(targetGroupId, topicName) as unknown as ForumTopic;
            addTopic(uid, targetGroupId, topicName, result.message_thread_id);
            // Apply initial config if provided
            const mcpEnabled = cmd.params.mcp_enabled as string[] | null | undefined;
            if (mcpEnabled !== undefined) {
              const required = ["session-comm", "send-file", "cron-manager"];
              const safe = mcpEnabled === null
                ? null
                : [...new Set([...mcpEnabled, ...required.filter(r => !mcpEnabled.includes(r))])];
              setTopicMcpEnabled(topicName, safe);
            }
            if (cmd.params.cwd) setTopicCwd(topicName, cmd.params.cwd as string);
            if (cmd.params.model && cmd.params.model !== "default") setTopicModel(topicName, cmd.params.model as string);
            if (cmd.params.effort && cmd.params.effort !== "default") setTopicEffort(topicName, cmd.params.effort as EffortLevel);
            const link = getTopicLink(targetGroupId, result.message_thread_id);
            writeResponse(respFile, { success: true, link });
          } catch (e) {
            writeResponse(respFile, { success: false, error: e instanceof Error ? e.message : "unknown" });
          }
        } else if (cmd.action === "delete_topic") {
          if (!config) {
            writeResponse(respFile, { success: false, error: "No config" });
            continue;
          }
          const lookupName = withTopicPrefix(cmd.params.name as string);
          const topic = getTopicByName(lookupName);
          if (!topic) {
            writeResponse(respFile, { success: false, error: "Topic not found" });
            continue;
          }
          try {
            const result = await deleteTopicWithArchive({
              userId: uid,
              topicName: lookupName,
              sessionId: topic.sessionId || null,
              forumGroupId: topic.forumGroupId,
              messageThreadId: topic.messageThreadId,
            });
            writeResponse(respFile, result);
          } catch (e) {
            writeResponse(respFile, { success: false, error: e instanceof Error ? e.message : "unknown" });
          }
        } else if (cmd.action === "set_description") {
          const ok = setTopicDescription(withTopicPrefix(cmd.params.topic as string), cmd.params.description as string);
          writeResponse(respFile, { success: ok, error: ok ? undefined : "Topic not found" });
        } else if (cmd.action === "set_topic_cwd") {
          const cwd = cmd.params.cwd as string | null;
          const ok = setTopicCwd(withTopicPrefix(cmd.params.topic as string), cwd);
          writeResponse(respFile, { success: ok, error: ok ? undefined : "Topic not found" });
        } else if (cmd.action === "set_topic_model") {
          const model = cmd.params.model === "default" ? null : cmd.params.model as string;
          const ok = setTopicModel(withTopicPrefix(cmd.params.topic as string), model);
          writeResponse(respFile, { success: ok, error: ok ? undefined : "Topic not found" });
        } else if (cmd.action === "set_topic_effort") {
          const effort = cmd.params.effort === "default" ? null : cmd.params.effort as EffortLevel;
          const ok = setTopicEffort(withTopicPrefix(cmd.params.topic as string), effort);
          writeResponse(respFile, { success: ok, error: ok ? undefined : "Topic not found" });
        } else if (cmd.action === "set_topic_mcp_enabled") {
          const rawEnabled = cmd.params.enabled as string[] | null;
          const required = ["session-comm", "send-file", "cron-manager"];
          const safeEnabled = rawEnabled === null
            ? null
            : [...new Set([...rawEnabled, ...required.filter(r => !rawEnabled.includes(r))])];
          const ok = setTopicMcpEnabled(withTopicPrefix(cmd.params.topic as string), safeEnabled);
          writeResponse(respFile, { success: ok, error: ok ? undefined : "Topic not found" });
        } else if (cmd.action === "set_topic_mcp_extra") {
          const ok = setTopicMcpExtra(withTopicPrefix(cmd.params.topic as string), cmd.params.extra as Record<string, unknown>);
          writeResponse(respFile, { success: ok, error: ok ? undefined : "Topic not found" });
        } else if (cmd.action === "set_topic_agent") {
          const agent = cmd.params.agent as AgentKind;
          const ok = setTopicAgent(withTopicPrefix(cmd.params.topic as string), agent);
          writeResponse(respFile, { success: ok, error: ok ? undefined : "Topic not found" });
        } else if (cmd.action === "send_file") {
          const topic = String(cmd.params.topic ?? "dm");
          const filePath = cmd.params.file_path as string | undefined;
          if (!filePath) {
            writeResponse(respFile, { success: false, error: "file_path is required" });
            continue;
          }
          const guard = isFileAllowedForTopic(filePath, topic);
          if (!guard.ok) {
            writeResponse(respFile, { success: false, error: `Access denied: ${guard.reason}` });
            continue;
          }
          let chatId: number;
          let threadOpts: { message_thread_id?: number } = {};
          if (topic === "dm") {
            chatId = uid;
          } else {
            const topicInfo = getTopicByName(withTopicPrefix(topic));
            if (!topicInfo) {
              writeResponse(respFile, { success: false, error: `Topic not found: ${topic}` });
              continue;
            }
            chatId = topicInfo.forumGroupId;
            threadOpts = { message_thread_id: topicInfo.messageThreadId };
          }
          try {
            const sent = await sendFileToChat(chatId, filePath, threadOpts);
            if (sent) {
              writeResponse(respFile, { success: true, messageId: sent.messageId });
            } else {
              writeResponse(respFile, { success: false, error: "File too large to upload" });
            }
          } catch (e) {
            writeResponse(respFile, { success: false, error: e instanceof Error ? e.message : "Send failed" });
          }
        } else {
          writeResponse(respFile, { success: false, error: `Unknown action: ${cmd.action}` });
        }
      } catch (e) {
        logger.warn({ err: e, file }, "dm-commands: Failed to process command");
        remaining.push(line);
      }
    }

    cleanupProcessing(filePath);

    // Write back failed lines for retry on next poll
    if (remaining.length > 0) {
      try {
        appendFileSync(filePath, remaining.join("\n") + "\n");
      } catch (e) {
        logger.warn({ err: e, file }, "dm-commands: Failed to write back remaining");
      }
    }
  }
}
