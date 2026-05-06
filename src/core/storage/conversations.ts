import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "@/core/config";
import { logger } from "@/core/logger";
import { sanitizeTopicName } from "@/core/sanitize";
import type { AgentKind, UnifiedEvent } from "@/core/types";

export interface ConversationEntry {
  ts: string;
  agent: AgentKind;
  event: UnifiedEvent;
}

function safeUserIdComponent(userId: number | string): string {
  const str = String(userId);
  if (!str || /[/\\]|\.\./.test(str)) {
    throw new Error(`conversations: refusing unsafe userId path component: ${str}`);
  }
  return str;
}

function conversationDir(userId: number | string): string {
  return join(DATA_DIR, "conversations", safeUserIdComponent(userId));
}

function topicFilename(topicName: string, groupId: number | undefined): string {
  const t = sanitizeTopicName(topicName, true);
  return groupId !== undefined ? `${groupId}_${t}.jsonl` : `${t}.jsonl`;
}

function legacyTopicFilename(topicName: string): string {
  return `${sanitizeTopicName(topicName, true)}.jsonl`;
}

export function getConversationPath(
  userId: number | string,
  topicName: string,
  groupId?: number,
): string {
  return join(conversationDir(userId), topicFilename(topicName, groupId));
}

function resolveReadPaths(
  userId: number | string,
  topicName: string,
  groupId: number | undefined,
): string[] {
  const primary = getConversationPath(userId, topicName, groupId);
  if (groupId === undefined) return [primary];
  const legacyPath = join(conversationDir(userId), legacyTopicFilename(topicName));
  return [primary, legacyPath];
}

export function appendConversationEvent(
  userId: number | string,
  topicName: string,
  agent: AgentKind,
  event: UnifiedEvent,
  groupId?: number,
): void {
  const path = getConversationPath(userId, topicName, groupId);
  const entry: ConversationEntry = { ts: new Date().toISOString(), agent, event };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    logger.warn({ err, userId, topicName, groupId, eventType: event.type }, "appendConversationEvent: write failed");
  }
}

export function readConversation(
  userId: number | string,
  topicName: string,
  groupId?: number,
): ConversationEntry[] {
  const paths = resolveReadPaths(userId, topicName, groupId);
  const out: ConversationEntry[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      logger.warn({ err, path }, "readConversation: read failed");
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ConversationEntry);
      } catch (err) {
        logger.warn({ err, line: line.slice(0, 200) }, "readConversation: malformed JSONL line skipped");
      }
    }
  }
  if (paths.length > 1) out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}

export function findLastSessionIdForAgent(
  entries: ConversationEntry[],
  agent: AgentKind,
): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.agent !== agent) continue;
    if (entry.event.type === "session") return entry.event.sessionId;
  }
  return null;
}
