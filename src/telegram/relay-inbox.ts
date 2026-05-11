/**
 * relay-inbox.ts — Cross-server relay client
 *
 * On bot startup:
 *   1. Registers this server + its topic list with the Hub
 *   2. Subscribes to Hub SSE stream for incoming messages
 *   3. On incoming tell/ask: writes to local run/session-inbox/{userId}/{topic}.jsonl
 *
 * Reconnects automatically on disconnect.
 */
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { ROUTER_URL, SERVER_NAME, SESSION_INBOX_DIR } from "@/core/config";
import { logger } from "@/core/logger";
import { getTopicNames, getTopicUserId, getTopicByName } from "@/telegram/forum-sessions";

let _stopped = false;
let _currentController: AbortController | null = null;

/** Push current topic list to Hub. Call whenever topics are created/deleted. */
export async function syncTopicsToHub(): Promise<void> {
  if (!ROUTER_URL || !SERVER_NAME) return;
  try {
    const topics = getTopicNames();
    await fetch(`${ROUTER_URL}/relay/sessions/${SERVER_NAME}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topics }),
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, "relay: syncTopicsToHub failed");
  }
}

async function registerWithHub(): Promise<void> {
  const topics = getTopicNames();
  await fetch(`${ROUTER_URL}/relay/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId: SERVER_NAME, topics }),
  });
  logger.info({ serverId: SERVER_NAME, topicCount: topics.length }, "relay: registered with Hub");
}

function handleRelayReply(event: Record<string, unknown>): void {
  const { requestId, text, fromServer, fromTopic, sourceTopic, aborted } = event as {
    requestId?: string;
    text: string;
    fromServer: string;
    fromTopic: string;
    sourceTopic: string;
    aborted?: boolean;
  };

  if (!sourceTopic || !text) return;

  const userId = getTopicUserId(sourceTopic);
  if (userId === null) {
    logger.warn({ sourceTopic, fromServer }, "relay reply: source topic not found locally");
    return;
  }

  // Deliver as a tell into the source topic's inbox so session-inbox.ts handles it normally
  const inboxDir = join(SESSION_INBOX_DIR, String(userId));
  mkdirSync(inboxDir, { recursive: true });

  const entry = {
    type: "tell" as const,
    from: `${fromServer}/${fromTopic}`,
    message: aborted ? text : `[← ${fromTopic}]\n${text}`,
    depth: 0,
    requestId,
    timestamp: new Date().toISOString(),
  };

  appendFileSync(join(inboxDir, `${sourceTopic}.jsonl`), JSON.stringify(entry) + "\n");
  logger.info({ sourceTopic, fromServer, fromTopic, requestId }, "relay reply: delivered to source inbox");
}

function handleRelayEvent(event: Record<string, unknown>): void {
  const { type, topic, from, fromServer, message, depth, requestId, contextId, fromDepth } = event as {
    type: string;
    topic: string;
    from: string;
    fromServer: string;
    message: string;
    depth?: number;
    requestId?: string;
    contextId?: string;
    fromDepth?: number;
  };

  if (type === "reply") {
    handleRelayReply(event);
    return;
  }

  if (type !== "tell" && type !== "ask") return;
  if (!topic || !message) return;

  const userId = getTopicUserId(topic);
  if (userId === null) {
    logger.warn({ topic, fromServer }, "relay: received message for unknown topic");
    return;
  }

  const inboxDir = join(SESSION_INBOX_DIR, String(userId));
  mkdirSync(inboxDir, { recursive: true });

  const entry =
    type === "tell"
      ? {
          type: "tell" as const,
          from: `${fromServer}/${from}`,
          message,
          depth: (depth ?? 1),
          timestamp: new Date().toISOString(),
        }
      : {
          type: "ask" as const,
          requestId,
          from: `${fromServer}/${from}`,
          message,
          contextId,
          fromDepth: (fromDepth ?? 0),
          timestamp: new Date().toISOString(),
        };

  appendFileSync(join(inboxDir, `${topic}.jsonl`), JSON.stringify(entry) + "\n");
  logger.info({ topic, fromServer, type }, "relay: delivered to local inbox");
}

async function connectSSE(): Promise<void> {
  if (_stopped) return;

  _currentController = new AbortController();

  try {
    await registerWithHub();

    const res = await fetch(`${ROUTER_URL}/relay/stream/${SERVER_NAME}`, {
      signal: _currentController.signal,
      headers: { Accept: "text/event-stream" },
    });

    if (!res.ok || !res.body) {
      throw new Error(`SSE connect failed: ${res.status}`);
    }

    logger.info({ serverId: SERVER_NAME }, "relay: SSE stream connected");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
            handleRelayEvent(event);
          } catch { /* malformed JSON, ignore */ }
        }
      }
    }
  } catch (err: any) {
    if (_stopped || err?.name === "AbortError") return;
    logger.warn({ err: err?.message }, "relay: SSE disconnected, reconnecting in 5s");
  }

  if (!_stopped) {
    await new Promise((r) => setTimeout(r, 5000));
    void connectSSE();
  }
}

/** Start relay inbox. Returns a cleanup function. */
export function startRelayInbox(): () => void {
  if (!ROUTER_URL || !SERVER_NAME) {
    logger.info("relay: ROUTER_URL not set, relay inbox disabled");
    return () => {};
  }

  _stopped = false;
  void connectSSE();

  // Sync topics to Hub every 5 minutes
  const syncInterval = setInterval(() => { void syncTopicsToHub(); }, 5 * 60 * 1000);

  return () => {
    _stopped = true;
    clearInterval(syncInterval);
    _currentController?.abort();
    logger.info("relay: inbox stopped");
  };
}
