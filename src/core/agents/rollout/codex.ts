import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertUuidLike, type ChatPair, clone, ensureCwdExists, extractChatPairs, FIXTURES_DIR,
} from "@/core/agents/rollout/shared";
import { parseJsonlText, writeJsonlFile } from "@/core/jsonl";
import { logger } from "@/core/logger";
import type { ConversationEntry } from "@/core/storage/conversations";

interface CodexShell {
  sessionMeta: Record<string, unknown>;
  taskStarted: Record<string, unknown>;
  developerSetup: Record<string, unknown>;
  envContext: Record<string, unknown>;
  turnContext: Record<string, unknown>;
}

let _shellCache: CodexShell | null = null;
function loadCodexShell(): CodexShell {
  if (_shellCache) return _shellCache;
  const raw = readFileSync(join(FIXTURES_DIR, "codex-shell.jsonl"), "utf8");
  const lines = parseJsonlText<Record<string, unknown>>(raw);
  if (lines.length < 5) throw new Error(`loadCodexShell: expected >=5 entries, got ${lines.length}`);
  _shellCache = {
    sessionMeta: lines[0], taskStarted: lines[1],
    developerSetup: lines[2], envContext: lines[3], turnContext: lines[4],
  };
  return _shellCache;
}

function uuidv7(): string {
  const ts = Date.now();
  const tsHex = ts.toString(16).padStart(12, "0");
  const rand = randomBytes(10);
  rand[0] = (rand[0] & 0x0f) | 0x70;
  rand[2] = (rand[2] & 0x3f) | 0x80;
  return [
    tsHex.slice(0, 8), tsHex.slice(8, 12),
    rand.slice(0, 2).toString("hex"), rand.slice(2, 4).toString("hex"),
    rand.slice(4, 10).toString("hex"),
  ].join("-");
}

function patchEnvContextCwd(envContext: Record<string, unknown>, cwd: string): void {
  const payload = envContext.payload as Record<string, unknown> | undefined;
  if (!payload) return;
  const content = payload.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === "input_text" && typeof block.text === "string") {
      block.text = block.text.replace(/<cwd>[^<]*<\/cwd>/, `<cwd>${cwd}</cwd>`);
    }
  }
}

export interface CodexRolloutOptions {
  cwd: string;
  threadId?: string;
  pairs?: ChatPair[];
  entries?: ConversationEntry[];
}

export interface CodexRolloutResult {
  threadId: string;
  rolloutPath: string;
}

export function writeCodexRollout(opts: CodexRolloutOptions): CodexRolloutResult {
  const threadId = opts.threadId ?? uuidv7();
  assertUuidLike("threadId", threadId);
  ensureCwdExists(opts.cwd);
  const pairs = opts.pairs ?? extractChatPairs(opts.entries ?? []);
  const now = new Date();
  const tsIso = now.toISOString();

  const shell = loadCodexShell();
  const sessionMeta = clone(shell.sessionMeta);
  Object.assign(sessionMeta.payload as Record<string, unknown>, { id: threadId, timestamp: tsIso, cwd: opts.cwd });
  (sessionMeta as Record<string, unknown>).timestamp = tsIso;

  const taskStarted = clone(shell.taskStarted);
  (taskStarted as Record<string, unknown>).timestamp = tsIso;

  const developerSetup = clone(shell.developerSetup);
  (developerSetup as Record<string, unknown>).timestamp = tsIso;

  const envContext = clone(shell.envContext);
  (envContext as Record<string, unknown>).timestamp = tsIso;
  patchEnvContextCwd(envContext, opts.cwd);

  const turnContext = clone(shell.turnContext);
  (turnContext as Record<string, unknown>).timestamp = tsIso;
  (turnContext.payload as Record<string, unknown>).cwd = opts.cwd;

  const lines: unknown[] = [sessionMeta, taskStarted, developerSetup, envContext, turnContext];

  for (const pair of pairs) {
    lines.push({
      timestamp: tsIso, type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: pair.userText }] },
    });
    lines.push({
      timestamp: tsIso, type: "event_msg",
      payload: { type: "user_message", message: pair.userText, images: [], local_images: [], text_elements: [] },
    });
    lines.push({
      timestamp: tsIso, type: "event_msg",
      payload: { type: "agent_message", message: pair.assistantText, phase: "final_answer", memory_citation: null },
    });
    lines.push({
      timestamp: tsIso, type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: pair.assistantText }], phase: "final_answer" },
    });
  }
  lines.push({ timestamp: tsIso, type: "event_msg", payload: { type: "task_complete" } });

  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const tsStr = tsIso.replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(homedir(), ".codex", "sessions", String(yyyy), mm, dd);
  const path = join(dir, `rollout-${tsStr}-${threadId}.jsonl`);
  writeJsonlFile(path, lines);
  logger.info({ threadId, path, pairs: pairs.length }, "writeCodexRollout: synthetic rollout placed");
  return { threadId, rolloutPath: path };
}
