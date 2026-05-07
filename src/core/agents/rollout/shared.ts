import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "@/core/config";
import { logger } from "@/core/logger";
import type { ConversationEntry } from "@/core/storage/conversations";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(__dirname, "..", "fixtures");

export function clone<T>(obj: T): T { return structuredClone(obj); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuidLike(label: string, value: string): void {
  if (!UUID_RE.test(value)) throw new Error(`rollout: ${label} is not a UUID-shaped string: ${value}`);
}

function assertCwdInWorkspace(cwd: string): void {
  const abs = resolve(cwd);
  const ok = abs === DATA_DIR || abs.startsWith(`${DATA_DIR}/`) ||
             abs.startsWith(`${resolve(process.env.HOME || "~")}/`);
  if (!ok) throw new Error(`rollout: cwd outside trusted roots: ${cwd}`);
}

export function ensureCwdExists(cwd: string): void {
  assertCwdInWorkspace(cwd);
  try { mkdirSync(cwd, { recursive: true }); }
  catch (err) { logger.warn({ err, cwd }, "rollout: ensureCwdExists failed"); }
}

function truncate(text: string, n: number): string {
  const cps = Array.from(text);
  return cps.length > n ? `${cps.slice(0, n).join("")}…` : text;
}

export type ChatPair = { userText: string; assistantText: string };

export function extractChatPairs(
  entries: ConversationEntry[],
  opts: { includeToolAnnotations: boolean } = { includeToolAnnotations: true },
): ChatPair[] {
  const pairs: ChatPair[] = [];
  let pendingUser: string | null = null;
  let pendingAssistantParts: string[] = [];
  let toolBuffer: string[] = [];

  const flushAssistant = () => {
    if (pendingUser === null) return;
    const tools = opts.includeToolAnnotations && toolBuffer.length > 0 ? `\n\n${toolBuffer.join("\n")}` : "";
    const assistantText = pendingAssistantParts.join("").trim() + tools;
    if (assistantText.trim()) pairs.push({ userText: pendingUser, assistantText });
    pendingUser = null;
    pendingAssistantParts = [];
    toolBuffer = [];
  };

  for (const entry of entries) {
    const ev = entry.event;
    switch (ev.type) {
      case "user_message": flushAssistant(); pendingUser = ev.content; break;
      case "session":
        if (pendingAssistantParts.length > 0 || toolBuffer.length > 0) flushAssistant();
        break;
      case "text":
        if (pendingUser === null) pendingUser = "(continued)";
        pendingAssistantParts.push(ev.content);
        break;
      case "result":
        if (pendingUser === null) pendingUser = "(continued)";
        pendingAssistantParts = [ev.content];
        flushAssistant();
        break;
      case "text_delta": break;
      case "tool_use":
        toolBuffer.push(`[Tool: ${ev.name} ${truncate(JSON.stringify(ev.input), 200)}]`);
        break;
      case "tool_result":
        toolBuffer.push(`[Tool result: ${truncate(ev.content, 200)}]`);
        break;
      case "error":
        toolBuffer.push(`[Error: ${truncate(ev.content, 200)}]`);
        break;
      case "tool_progress":
      case "tool_use_summary":
        break;
    }
  }
  flushAssistant();
  return pairs;
}
