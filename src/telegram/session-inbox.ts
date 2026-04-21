import { readdirSync, existsSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { sendMsg, sendSplitMsg } from "@/telegram/helpers";
import { getUserConfig, getTopicByName } from "@/telegram/forum-sessions";
import { logger } from "@/core/logger";
import { USERS_LOG_DIR, SESSION_INBOX_DIR } from "@/core/config";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { getSessionInjectHandler, getAbortHandler } from "@/telegram/outbox-types";
import { loadContext, formatContextForPrompt, appendContext } from "@/core/context-store";
import { acquireJsonlLines, cleanupProcessing } from "@/telegram/outbox-utils";

export { SESSION_INBOX_DIR };

interface SessionInboxEntry {
  type?: "abort";
  requestId?: string;
  from?: string;
  message?: string;
  contextId?: string;
  depth?: number;
  maxDepth?: number;
  chain?: string[];
  command?: boolean;
  timestamp: string;
}

export async function flushSessionInbox() {
  let userDirs: string[];
  try {
    userDirs = readdirSync(SESSION_INBOX_DIR);
  } catch {
    return;
  }

  for (const uid of userDirs) {
    const userId = Number(uid);
    if (isNaN(userId)) continue;

    const userInboxDir = join(SESSION_INBOX_DIR, uid);
    let inboxFiles: string[];
    try {
      inboxFiles = readdirSync(userInboxDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    const config = getUserConfig(userId);
    if (!config) continue;

    for (const file of inboxFiles) {
      const topicName = basename(file, ".jsonl");
      const filePath = join(userInboxDir, file);

      const lines = acquireJsonlLines(filePath, "session-inbox");
      if (!lines) continue;
      cleanupProcessing(filePath);

      for (const line of lines) {
        let entry: SessionInboxEntry;
        try {
          entry = JSON.parse(line);
        } catch {
          logger.error({ line }, "session-inbox: Invalid JSON, dropping");
          continue;
        }

        // abort signal: call registered abort handler to cancel the target topic's running query
        if (entry.type === "abort") {
          const abortHandler = getAbortHandler();
          if (abortHandler) {
            const aborted = abortHandler(userId, topicName);
            logger.info({ userId, topicName, aborted }, "session-inbox: abort processed");
          } else {
            logger.warn({ userId, topicName }, "session-inbox: No abortHandler registered");
          }
          continue;
        }

        // Non-abort entries must carry from + message
        if (!entry.from || !entry.message) {
          logger.error({ entry }, "session-inbox: missing from/message, dropping");
          continue;
        }

        const _sessionInjectHandler = getSessionInjectHandler();

        const topic = getTopicByName(topicName);
        if (!topic) {
          logger.warn({ userId, topicName }, "session-inbox: Topic not found, dropping entry");
          if (!entry.command && entry.from) {
            const senderTopic = getTopicByName(entry.from);
            if (senderTopic) {
              sendMsg(senderTopic.forumGroupId, `[← ${topicName}]\n(오류: 토픽 "${topicName}"을 찾을 수 없습니다)`, {
                message_thread_id: senderTopic.messageThreadId,
              }).catch((e) => logger.warn({ err: e, topicName, userId }, "session-inbox: Failed to notify sender of missing topic"));
            }
          }
          continue;
        }

        if (!topic.sessionId) {
          logger.warn({ userId, topicName }, "session-inbox: No sessionId, dropping entry");
          if (!entry.command && entry.from) {
            const senderTopic = getTopicByName(entry.from);
            if (senderTopic) {
              sendMsg(senderTopic.forumGroupId, `[← ${topicName}]\n(오류: "${topicName}" 세션이 아직 초기화되지 않았습니다. 해당 토픽에 먼저 메시지를 보내주세요)`, {
                message_thread_id: senderTopic.messageThreadId,
              }).catch((e) => logger.warn({ err: e, topicName, userId }, "session-inbox: Failed to notify sender of missing session"));
            }
          }
          continue;
        }

        if (!_sessionInjectHandler) {
          logger.warn("session-inbox: No sessionInjectHandler registered");
          continue;
        }

        // command_session: show as visible Telegram message + process with output displayed
        // isCommand: true → isInject=false → tool use, thinking, result all shown in the topic
        // depth: 1 → command_session not registered (depth===0 only) → prevents re-commanding loops
        if (entry.command) {
          const visibleText = `[from: ${entry.from}]\n${entry.message}`;
          await sendSplitMsg(topic.forumGroupId, visibleText, { message_thread_id: topic.messageThreadId }).catch((e) =>
            logger.warn({ err: e, topicName }, "session-inbox: command sendMsg failed")
          );
          const commandRequestId = entry.requestId ?? `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await _sessionInjectHandler({
            userId,
            topicName,
            sessionId: topic.sessionId,
            prompt: visibleText,
            messageThreadId: topic.messageThreadId,
            forumGroupId: topic.forumGroupId,
            from: entry.from,
            depth: 1,
            chain: [entry.from, topicName],
            isCommand: true,
            requestId: commandRequestId,
          }).catch((e) => logger.error({ err: e, topicName }, "session-inbox: command inject failed"));
          continue;
        }

        if (entry.depth == null || entry.chain == null) {
          logger.error({ userId, topicName, entry }, "session-inbox: ask_session entry missing depth/chain, dropping");
          if (entry.from) {
            const senderTopic = getTopicByName(entry.from);
            if (senderTopic) {
              sendMsg(senderTopic.forumGroupId, `[${topicName} 오류] ask_session 응답 실패: depth/chain 정보 누락`, { message_thread_id: senderTopic.messageThreadId }).catch(() => {});
            }
          }
          continue;
        }
        // Load previous context exchanges, then save current message
        const contextPrefix = entry.contextId
          ? formatContextForPrompt(loadContext(userId, entry.contextId))
          : "";
        if (entry.contextId) {
          appendContext(userId, entry.contextId, { role: entry.from, content: entry.message, ts: new Date().toISOString() });
        }
        const prompt = `${contextPrefix}[${entry.from} 세션에서 온 메시지 (depth: ${entry.depth}/${entry.maxDepth ?? "∞"}, chain: ${entry.chain.join(" → ")})]\n${entry.message}\n\n위 메시지에 응답해주세요. 응답은 자동으로 "${entry.from}" 세션으로 전달됩니다.`;

        logger.info({ userId, topicName, from: entry.from, requestId: entry.requestId, depth: entry.depth },
          "session-inbox: Injecting via fork");

        // Show outgoing request in sender's topic (await to ensure [→] appears before [←])
        const senderTopic = getTopicByName(entry.from);
        if (senderTopic) {
          await sendSplitMsg(senderTopic.forumGroupId, `[→ ${topicName}]\n${entry.message}`, { message_thread_id: senderTopic.messageThreadId }).catch(
            (e) => logger.warn({ err: e }, "session-inbox: failed to send outgoing notification to sender")
          );
        }

        // Fork B's session to avoid occupying the main session
        let forkId: string | undefined;
        try {
          const userCwd = join(USERS_LOG_DIR, String(userId));
          try {
            const result = await forkSession(topic.sessionId, {
              dir: userCwd,
              title: `chain: ${entry.from} → ${topicName}`,
            });
            forkId = result.sessionId;
            logger.info({ forkId, topicName }, "session-inbox: Forked B session");
          } catch (forkErr) {
            logger.warn({ err: forkErr, topicName }, "session-inbox: forkSession failed, using original session");
            forkId = undefined;
          }

          await _sessionInjectHandler({
            userId,
            topicName,
            sessionId: forkId || topic.sessionId,
            prompt,
            messageThreadId: topic.messageThreadId,
            forumGroupId: topic.forumGroupId,
            from: entry.from,
            depth: entry.depth,
            chain: entry.chain,
            requestId: entry.requestId,
            contextId: entry.contextId,
          });
        } catch (err) {
          logger.error({ err, userId, topicName, requestId: entry.requestId }, "session-inbox: sessionInject failed");
          if (senderTopic) {
            sendMsg(senderTopic.forumGroupId, `[← ${topicName}]\n(오류: 세션 처리 실패)`, {
              message_thread_id: senderTopic.messageThreadId,
            }).catch((e) => logger.warn({ err: e }, "session-inbox: failed to notify sender of inject failure"));
          }
        } finally {
          // Clean up fork session file
          if (forkId) {
            try {
              const sessionsDir = join(USERS_LOG_DIR, String(userId), ".claude", "sessions");
              const forkFile = join(sessionsDir, `${forkId}.jsonl`);
              if (existsSync(forkFile)) {
                unlinkSync(forkFile);
                logger.info({ forkId }, "session-inbox: Cleaned up fork");
              }
            } catch {}
          }
        }
      }
    }
  }
}
