import { existsSync, appendFileSync, mkdirSync, unlinkSync, readFileSync, writeFileSync } from "fs";
import { Database } from "bun:sqlite";
import { join, resolve } from "path";
import { homedir } from "os";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { PROJECT_ROOT, getCleanEnv, PROGRESS_DIR as CONFIG_PROGRESS_DIR, SESSION_INBOX_DIR, DEBUG_FILE, SESSIONS_DB as CONFIG_SESSIONS_DB, SERVER_NAME } from "@/core/config";
import { getForkMcpServers } from "@/core/mcp-config";
export { SESSION_INBOX_DIR };
import type { QueryState } from "@/core/types";
export type { QueryState };

// --- Constants & CLI args ---

export const HOME = homedir();
export const SESSIONS_DB = CONFIG_SESSIONS_DB;
export const PROGRESS_DIR = CONFIG_PROGRESS_DIR;

// Parse CLI args
const args = process.argv.slice(2);
export const userId = args.find((a) => a.startsWith("--user-id="))?.split("=")[1] || "";
export const currentTopic = args.find((a) => a.startsWith("--topic="))?.split("=")[1] || "";
export const currentDepth = Number(args.find((a) => a.startsWith("--depth="))?.split("=")[1] ?? "0");
// When true, the session is a silent fork generating an ask_session reply —
// outbound tools (ask_session/tell_session/abort_session) are not registered.
export const isReplyOnly = args.includes("--reply-only=true");
// Progress writes (ask_cron fork) land in the calling session's topic thread.
export const progressTopic = currentTopic;

// Max tell_session relay depth from origin user. ask_session forks reset
// to depth=0 (reply-only, can't initiate further calls), so this only caps
// tell_session chains.
export const MAX_TELL_DEPTH = 3;
export const MAX_MESSAGE_LENGTH = 10_000;
export const USER_DATA_DIR = resolve(__dirname, "..", "..", "data", "users", userId);

function expandHome(p: string | null | undefined): string | null {
  if (!p) return null;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return p;
}

/** Get the cwd for a topic from DB, with ~ expansion. Falls back to ~/. */
export function getTopicCwd(topicName?: string): string {
  const name = topicName || currentTopic;
  if (!name) return HOME;
  const topics = getTopicsForUser();
  const entry = topics[name];
  return expandHome(entry?.cwd) || HOME;
}

// --- DB helpers ---

export interface TopicEntry {
  sessionId: string;
  cronSessionId?: string;
  messageThreadId: number;
  name: string;
  description?: string;
  cwd?: string;
}

export function getTopicsForUser(): { [name: string]: TopicEntry } {
  if (!existsSync(SESSIONS_DB)) return {};
  const db = new Database(SESSIONS_DB, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    const rows = db.query<{
      name: string;
      session_id: string | null;
      cron_session_id: string | null;
      message_thread_id: number;
      description: string | null;
      cwd: string | null;
    }, string>(
      "SELECT name, session_id, cron_session_id, message_thread_id, description, cwd FROM topics WHERE server_name = ?"
    ).all(SERVER_NAME);
    const result: { [name: string]: TopicEntry } = {};
    for (const row of rows) {
      result[row.name] = {
        sessionId: row.session_id ?? "",
        ...(row.cron_session_id && { cronSessionId: row.cron_session_id }),
        messageThreadId: row.message_thread_id,
        name: row.name,
        ...(row.description && { description: row.description }),
        ...(row.cwd && { cwd: row.cwd }),
      };
    }
    return result;
  } catch {
    return {};
  } finally {
    db.close();
  }
}

// --- Debug helpers ---

let _isDebugUser: boolean | undefined = undefined;
export function isDebugUser(): boolean {
  if (_isDebugUser !== undefined) return _isDebugUser;
  try {
    if (!existsSync(DEBUG_FILE)) return (_isDebugUser = false);
    const users: (string | number)[] = JSON.parse(readFileSync(DEBUG_FILE, "utf-8"));
    return (_isDebugUser = users.some((u) => String(u) === String(userId)));
  } catch {
    return (_isDebugUser = false);
  }
}

// --- Progress outbox helpers ---

let _forumInfo: { forumGroupId: number; messageThreadId: number } | null | undefined = undefined;

export function getForumInfo(): { forumGroupId: number; messageThreadId: number } | null {
  if (_forumInfo !== undefined) return _forumInfo;
  if (!userId || !progressTopic) { _forumInfo = null; return null; }
  const db = new Database(SESSIONS_DB, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    const row = db.query<{ forum_group_id: number; message_thread_id: number }, [string, string]>(
      "SELECT forum_group_id, message_thread_id FROM topics WHERE server_name = ? AND name = ?"
    ).get(SERVER_NAME, progressTopic);
    _forumInfo = row ? { forumGroupId: row.forum_group_id, messageThreadId: row.message_thread_id } : null;
  } catch { _forumInfo = null; }
  finally { db.close(); }
  return _forumInfo;
}

function appendProgressEntry(entry: Record<string, unknown>) {
  const info = getForumInfo();
  if (!info || !userId) return;
  const dir = join(PROGRESS_DIR, userId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${progressTopic}.jsonl`);
  try {
    appendFileSync(file, JSON.stringify({ ...info, timestamp: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

export const writeProgress = (type: "status" | "log", text: string) =>
  appendProgressEntry({ type, text });

export const clearProgress = () =>
  appendProgressEntry({ type: "clear" });

// --- Fork helpers ---

export function cleanupFork(forkId: string) {
  try {
    const forkFile = join(getTopicCwd(), ".claude", "sessions", `${forkId}.jsonl`);
    if (existsSync(forkFile)) unlinkSync(forkFile);
  } catch {}
}

export function formatToolUse(name: string, input: Record<string, unknown>): string {
  let detail = "";
  if (input.command) detail = String(input.command);
  else if (input.file_path || input.path) detail = String(input.file_path || input.path);
  else if (input.url) detail = String(input.url);
  else if (input.pattern) detail = String(input.pattern);
  else if (input.query || input.text) detail = String(input.query || input.text);
  else if (input.task) detail = String(input.task);
  else if (input.to) detail = String(input.to);
  else if (input.message) detail = String(input.message).slice(0, 80);
  else if (input.content) detail = String(input.content).slice(0, 80);
  if (detail) return `${name}(${detail.length > 100 ? detail.slice(0, 100) + "..." : detail})`;
  return name;
}

export interface ForkQueryResult {
  result: string;
  toolLog: string[];    // tool use — always shown briefly, then discarded
  thinkingLog: string[]; // intermediate reasoning — shown only in debug mode
}

/** Run SDK query on a (forked) session, collecting intermediate process + final result.
 *  Used by ask_cron to query a forked cron session synchronously. */
export async function queryForkSession(
  prompt: string,
  sessionId?: string,
  onProgress?: (type: "status" | "log", text: string) => void,
  abortController?: AbortController,
  systemPrompt?: string,
): Promise<ForkQueryResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const label = currentTopic;

  const baseOptions: Options = {
    cwd: getTopicCwd(label),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    mcpServers: getForkMcpServers({ userId, topic: label, depth: currentDepth }) as Options["mcpServers"],
    env: getCleanEnv(),
    ...(systemPrompt && { systemPrompt }),
    ...(abortController && { abortController }),
  };

  const options = baseOptions as Options & { settingSources?: string[]; resume?: string };
  options.settingSources = ["project"];
  if (sessionId) options.resume = sessionId;

  const toolLog: string[] = [];
  const thinkingLog: string[] = [];
  let finalResult = "";

  for await (const message of query({ prompt, options })) {
    if (message.type === "tool_use_summary") {
      const m = message as { type: "tool_use_summary"; summary: string };
      if (m.summary) {
        const text = `🔧 [${label}] ${m.summary}`;
        toolLog.push(text);
        onProgress?.("status", text);
      }
      continue;
    }

    if (message.type === "assistant") {
      const m = message as { type: "assistant"; message?: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> } };
      for (const block of m.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          const snippet = block.text.slice(0, 400);
          const text = `💭 [${label}] ${snippet}`;
          thinkingLog.push(text);
          onProgress?.("log", text);
        } else if (block.type === "tool_use" && block.name) {
          const toolText = `🔧 [${label}] ${formatToolUse(block.name, block.input ?? {})}`;
          toolLog.push(toolText);
          onProgress?.("status", toolText);
          if (isDebugUser()) onProgress?.("log", toolText);
        }
      }
      continue;
    }

    if (message.type === "result") {
      const m = message as { type: "result"; subtype?: string; result?: string; errors?: string[] };
      if (m.subtype === "success" && m.result) {
        finalResult = m.result;
      } else if (m.errors) {
        finalResult = `Error: ${m.errors.join("; ")}`;
      }
      continue;
    }
  }

  return { result: finalResult.trim(), toolLog, thinkingLog };
}

/** Format fork query result based on debug mode.
 *  - Tool use: NOT included in response (shown/discarded by caller's query-handler tool status)
 *  - Thinking: included only in debug mode
 *  - Result: always included
 */
export function formatForkResult(label: string, { result, toolLog, thinkingLog }: ForkQueryResult): string {
  const debug = isDebugUser();
  const parts: string[] = [];

  // Thinking — debug only
  if (debug && thinkingLog.length > 0) {
    parts.push(`[${label} 중간 과정]\n${thinkingLog.join("\n")}`);
  }

  // Result — always
  if (result) {
    parts.push(result);
  }

  return parts.join("\n\n");
}

// --- MCP config helpers ---

export function getMcpConfig(): { enabled: string[] | null; extra: Record<string, unknown> } {
  if (!existsSync(SESSIONS_DB)) return { enabled: null, extra: {} };
  const db = new Database(SESSIONS_DB, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    const row = db.query<{ mcp_enabled: string | null; mcp_extra: string | null }, [string, string]>(
      "SELECT mcp_enabled, mcp_extra FROM topics WHERE server_name = ? AND name = ?"
    ).get(SERVER_NAME, currentTopic);
    let enabled: string[] | null = null;
    let extra: Record<string, unknown> = {};
    try { if (row?.mcp_enabled) enabled = JSON.parse(row.mcp_enabled); } catch { console.error(`[session-comm] getMcpConfig: failed to parse mcp_enabled for topic "${currentTopic}"`); }
    try { if (row?.mcp_extra) extra = JSON.parse(row.mcp_extra); } catch { console.error(`[session-comm] getMcpConfig: failed to parse mcp_extra for topic "${currentTopic}"`); }
    return { enabled, extra };
  } catch { return { enabled: null, extra: {} }; }
  finally { db.close(); }
}

export function setCurrentTopicDescription(description: string) {
  const db = new Database(SESSIONS_DB);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.query("UPDATE topics SET description = ? WHERE server_name = ? AND name = ?").run(
      description, SERVER_NAME, currentTopic
    );
  } finally { db.close(); }
}

export function setMcpConfig(enabled?: string[] | null, extra?: Record<string, unknown>) {
  const db = new Database(SESSIONS_DB);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    if (enabled !== undefined) {
      db.query("UPDATE topics SET mcp_enabled = ? WHERE server_name = ? AND name = ?").run(
        enabled !== null ? JSON.stringify(enabled) : null, SERVER_NAME, currentTopic
      );
    }
    if (extra !== undefined) {
      db.query("UPDATE topics SET mcp_extra = ? WHERE server_name = ? AND name = ?").run(
        JSON.stringify(extra), SERVER_NAME, currentTopic
      );
    }
  } finally { db.close(); }
}
