import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertUuidLike, type ChatPair, clone, ensureCwdExists, extractChatPairs, FIXTURES_DIR,
} from "@/core/agents/rollout/shared";
import { parseJsonlText, writeJsonlFile } from "@/core/jsonl";
import { logger } from "@/core/logger";
import type { ConversationEntry } from "@/core/storage/conversations";

interface ClaudeAttachments {
  deferredToolsDelta: Record<string, unknown>;
  skillListing: Record<string, unknown>;
}

let _attachmentsCache: ClaudeAttachments | null = null;
function loadClaudeAttachments(): ClaudeAttachments {
  if (_attachmentsCache) return _attachmentsCache;
  const raw = readFileSync(join(FIXTURES_DIR, "claude-attachments.jsonl"), "utf8");
  const lines = parseJsonlText<Record<string, unknown>>(raw);
  if (lines.length < 2) throw new Error(`loadClaudeAttachments: expected >=2 entries, got ${lines.length}`);
  _attachmentsCache = { deferredToolsDelta: lines[0], skillListing: lines[1] };
  return _attachmentsCache;
}

const CLAUDE_SDK_VERSION = "2.1.126";
const CLAUDE_DEFAULT_MODEL = "claude-opus-4-7";
const CLAUDE_DEFAULT_GIT_BRANCH = "HEAD";

export function encodeClaudeCwd(cwd: string): string {
  const realCwd = cwd.startsWith("/tmp/") ? cwd.replace(/^\/tmp\//, "/private/tmp/") : cwd;
  return `-${realCwd.replaceAll(/[^a-zA-Z0-9]/g, "-").replace(/^-/, "")}`;
}

export interface ClaudeRolloutOptions {
  cwd: string;
  sessionId?: string;
  pairs?: ChatPair[];
  entries?: ConversationEntry[];
}

export interface ClaudeRolloutResult {
  sessionId: string;
  rolloutPath: string;
}

export function writeClaudeRollout(opts: ClaudeRolloutOptions): ClaudeRolloutResult {
  const sessionId = opts.sessionId ?? randomUUID();
  assertUuidLike("sessionId", sessionId);
  ensureCwdExists(opts.cwd);
  const pairs = opts.pairs ?? extractChatPairs(opts.entries ?? []);
  const cwdReal = opts.cwd.startsWith("/tmp/") ? opts.cwd.replace(/^\/tmp\//, "/private/tmp/") : opts.cwd;

  const lines: unknown[] = [];
  const ts = () => new Date().toISOString();
  let lastUuid: string | null = null;

  lines.push({ type: "queue-operation", operation: "enqueue", timestamp: ts(), sessionId });
  lines.push({ type: "queue-operation", operation: "dequeue", timestamp: ts(), sessionId });

  const attachments = loadClaudeAttachments();

  for (const pair of pairs) {
    const userUuid = randomUUID();
    lines.push({
      parentUuid: lastUuid, isSidechain: false, promptId: randomUUID(), type: "user",
      message: { role: "user", content: [{ type: "text", text: pair.userText }] },
      uuid: userUuid, timestamp: ts(), permissionMode: "bypassPermissions",
      userType: "external", entrypoint: "sdk-ts", cwd: cwdReal, sessionId,
      version: CLAUDE_SDK_VERSION, gitBranch: CLAUDE_DEFAULT_GIT_BRANCH,
    });

    const att1Uuid = randomUUID();
    const att1 = clone(attachments.deferredToolsDelta);
    Object.assign(att1, { parentUuid: userUuid, uuid: att1Uuid, timestamp: ts(), sessionId, cwd: cwdReal });
    lines.push(att1);

    const att2Uuid = randomUUID();
    const att2 = clone(attachments.skillListing);
    Object.assign(att2, { parentUuid: att1Uuid, uuid: att2Uuid, timestamp: ts(), sessionId, cwd: cwdReal });
    lines.push(att2);

    const assistantUuid = randomUUID();
    lines.push({
      parentUuid: att2Uuid, isSidechain: false,
      message: {
        model: CLAUDE_DEFAULT_MODEL,
        id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "message", role: "assistant",
        content: [{ type: "text", text: pair.assistantText }],
        stop_reason: "end_turn", stop_sequence: null, stop_details: null,
        usage: {
          input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          output_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
          service_tier: "standard",
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
          inference_geo: "", iterations: [], speed: "standard",
        },
        diagnostics: null,
      },
      requestId: `req_${randomUUID().replace(/-/g, "").slice(0, 22)}`,
      type: "assistant", uuid: assistantUuid, timestamp: ts(),
      userType: "external", entrypoint: "sdk-ts", cwd: cwdReal, sessionId,
      version: CLAUDE_SDK_VERSION, gitBranch: CLAUDE_DEFAULT_GIT_BRANCH,
    });
    lastUuid = assistantUuid;
  }

  const projectsDir = join(homedir(), ".claude", "projects", encodeClaudeCwd(opts.cwd));
  const path = join(projectsDir, `${sessionId}.jsonl`);
  writeJsonlFile(path, lines);
  logger.info({ sessionId, path, pairs: pairs.length }, "writeClaudeRollout: synthetic rollout placed");
  return { sessionId, rolloutPath: path };
}
