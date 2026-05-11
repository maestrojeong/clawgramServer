import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { logger } from "@/core/logger";
import { SESSIONS_DB, SERVER_NAME } from "@/core/config";
import type { AgentKind, AgentSettings, EffortLevel } from "@/core/types";
import { FALLBACK_AGENT, isAgentKind } from "@/core/agents";

/** Listener called when a user disconnects a forum group. Registered externally to avoid circular deps. */
let _onGroupRemoveListener: ((userId: number, groupId: number) => void) | null = null;
export function onForumGroupRemove(listener: (userId: number, groupId: number) => void) {
  _onGroupRemoveListener = listener;
}

// --- DB singleton ---
mkdirSync(dirname(SESSIONS_DB), { recursive: true });
const db = new Database(SESSIONS_DB, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    forum_group_ids TEXT NOT NULL DEFAULT '[]',
    forum_group_titles TEXT NOT NULL DEFAULT '{}',
    dm_session_id TEXT,
    communicate_thread_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS topics (
    user_id TEXT NOT NULL REFERENCES users(id),
    forum_group_id INTEGER NOT NULL,
    server_name TEXT NOT NULL,
    name TEXT NOT NULL,
    message_thread_id INTEGER NOT NULL,
    session_id TEXT,
    cron_session_id TEXT,
    created_at TEXT NOT NULL,
    description TEXT,
    model TEXT,
    cwd TEXT,
    effort TEXT CHECK (effort IN ('low', 'medium', 'high', 'max', 'xhigh', 'minimal')),
    mcp_enabled TEXT,
    mcp_extra TEXT,
    agent TEXT,
    agent_settings TEXT,
    PRIMARY KEY (server_name, forum_group_id, name),
    UNIQUE (forum_group_id, message_thread_id)
  );

  CREATE INDEX IF NOT EXISTS idx_topics_lookup ON topics(forum_group_id, message_thread_id);
`);

// Migrations: add new columns if they don't exist yet (for DBs created before these existed)
try { db.exec("ALTER TABLE topics ADD COLUMN mcp_enabled TEXT"); } catch {}
try { db.exec("ALTER TABLE topics ADD COLUMN mcp_extra TEXT"); } catch {}
try { db.exec("ALTER TABLE topics ADD COLUMN cwd TEXT"); } catch {}
try { db.exec("ALTER TABLE topics ADD COLUMN server_name TEXT"); } catch {}
try { db.exec("ALTER TABLE topics ADD COLUMN fork_origin TEXT"); } catch {}
try { db.exec("ALTER TABLE topics ADD COLUMN agent TEXT"); } catch {}
try { db.exec("ALTER TABLE topics ADD COLUMN agent_settings TEXT"); } catch {}
try { db.exec("ALTER TABLE topics ADD COLUMN last_shown_agent TEXT"); } catch {}
try { db.exec("ALTER TABLE topics ADD COLUMN last_shown_model TEXT"); } catch {}
try { db.exec("ALTER TABLE topics ADD COLUMN last_shown_effort TEXT"); } catch {}
// Rename system_prompt_extra → description
{
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(topics)").all();
  if (cols.some(c => c.name === "system_prompt_extra")) {
    db.exec("ALTER TABLE topics RENAME COLUMN system_prompt_extra TO description");
  }
}

// Migration: topics PK (user_id, name) → (server_name, forum_group_id, name).
// Topics become shared within a group — user_id stays as creator metadata only.
{
  const row = db.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='topics'"
  ).get();
  if (row?.sql.includes("PRIMARY KEY (user_id, name)")) {
    logger.info("Migrating topics PK: (user_id, name) → (server_name, forum_group_id, name)");
    db.transaction(() => {
      db.query("UPDATE topics SET server_name = ? WHERE server_name IS NULL").run(SERVER_NAME);
      type DupRow = { server_name: string; forum_group_id: number; name: string };
      const dups = db.query<DupRow, []>(
        "SELECT server_name, forum_group_id, name FROM topics GROUP BY server_name, forum_group_id, name HAVING COUNT(*) > 1"
      ).all();
      for (const d of dups) {
        const rowids = db.query<{ rowid: number }, [string, number, string]>(
          "SELECT rowid FROM topics WHERE server_name = ? AND forum_group_id = ? AND name = ? ORDER BY rowid"
        ).all(d.server_name, d.forum_group_id, d.name);
        // Keep the first, rename the rest with numeric suffix
        for (let i = 1; i < rowids.length; i++) {
          let suffix = i + 1;
          let candidate = `${d.name}_${suffix}`;
          while (db.query<{ n: number }, [string, number, string]>(
            "SELECT COUNT(*) as n FROM topics WHERE server_name = ? AND forum_group_id = ? AND name = ?"
          ).get(d.server_name, d.forum_group_id, candidate)!.n > 0) {
            suffix++;
            candidate = `${d.name}_${suffix}`;
          }
          db.query("UPDATE topics SET name = ? WHERE rowid = ?").run(candidate, rowids[i].rowid);
          logger.warn({ original: d.name, renamed: candidate, forumGroupId: d.forum_group_id }, "Topic PK migration: renamed duplicate");
        }
      }
      db.exec(`
        CREATE TABLE topics_new (
          user_id TEXT NOT NULL REFERENCES users(id),
          forum_group_id INTEGER NOT NULL,
          server_name TEXT NOT NULL,
          name TEXT NOT NULL,
          message_thread_id INTEGER NOT NULL,
          session_id TEXT,
          cron_session_id TEXT,
          created_at TEXT NOT NULL,
          description TEXT,
          model TEXT,
          cwd TEXT,
          effort TEXT CHECK (effort IN ('low', 'medium', 'high', 'max')),
          mcp_enabled TEXT,
          mcp_extra TEXT,
          PRIMARY KEY (server_name, forum_group_id, name),
          UNIQUE (forum_group_id, message_thread_id)
        );
        INSERT INTO topics_new (user_id, forum_group_id, server_name, name, message_thread_id, session_id, cron_session_id, created_at, description, model, cwd, effort, mcp_enabled, mcp_extra)
          SELECT user_id, forum_group_id, server_name, name, message_thread_id, session_id, cron_session_id, created_at, description, model, cwd, effort, mcp_enabled, mcp_extra FROM topics;
        DROP TABLE topics;
        ALTER TABLE topics_new RENAME TO topics;
        CREATE INDEX IF NOT EXISTS idx_topics_lookup ON topics(forum_group_id, message_thread_id);
      `);
    })();
    logger.info("Migration complete: topics PK");
  }
}

// Migration: forum_group_id (single INTEGER) → forum_group_ids (JSON array)
{
  const userCols = db.query<{ name: string }, []>("PRAGMA table_info(users)").all();
  const hasOldCol = userCols.some(c => c.name === "forum_group_id");
  const hasNewCol = userCols.some(c => c.name === "forum_group_ids");

  if (hasOldCol && !hasNewCol) {
    logger.info("Migrating users table: forum_group_id → forum_group_ids");
    db.transaction(() => {
      db.exec("ALTER TABLE users ADD COLUMN forum_group_ids TEXT NOT NULL DEFAULT '[]'");
      db.exec("ALTER TABLE users ADD COLUMN forum_group_titles TEXT NOT NULL DEFAULT '{}'");

      type OldUserRow = { id: string; forum_group_id: number; forum_group_title: string | null };
      const oldUsers = db.query<OldUserRow, []>("SELECT id, forum_group_id, forum_group_title FROM users").all();
      for (const u of oldUsers) {
        if (u.forum_group_id && u.forum_group_id !== 0) {
          const ids = JSON.stringify([u.forum_group_id]);
          const titles = JSON.stringify({ [String(u.forum_group_id)]: u.forum_group_title || "" });
          db.query("UPDATE users SET forum_group_ids = ?, forum_group_titles = ? WHERE id = ?").run(ids, titles, u.id);
        }
      }
    })();
    logger.info("Migration complete: forum_group_ids");
  }
}

// --- Types ---

export interface ForumTopicInfo {
  forumGroupId: number;
  messageThreadId: number;
  sessionId: string;
  cronSessionId?: string;
  createdAt: string;
  name: string;
  description?: string;
  model?: string;
  cwd?: string;
  effort?: EffortLevel;
  forkOrigin?: string;
  agent: AgentKind;
  agentSettings: AgentSettings;
}

export interface UserForumConfig {
  forumGroupIds: number[];
  forumGroupTitles: Record<string, string>;
  communicateThreadId?: number;
  dmSessionId?: string;
  topics: { [topicName: string]: ForumTopicInfo };
}

type TopicRow = {
  user_id: string;
  forum_group_id: number;
  name: string;
  message_thread_id: number;
  session_id: string | null;
  cron_session_id: string | null;
  created_at: string;
  description: string | null;
  model: string | null;
  cwd: string | null;
  effort: EffortLevel | null;
  fork_origin: string | null;
  agent: string | null;
  agent_settings: string | null;
};

type UserRow = {
  id: string;
  forum_group_ids: string;
  forum_group_titles: string;
  dm_session_id: string | null;
  communicate_thread_id: number | null;
};

function parseAgentSettings(raw: string | null): AgentSettings {
  if (!raw) return {};
  try { return JSON.parse(raw) as AgentSettings; } catch { return {}; }
}

function rowToTopic(row: TopicRow): ForumTopicInfo {
  const agent = isAgentKind(row.agent) ? row.agent : FALLBACK_AGENT;
  return {
    forumGroupId: row.forum_group_id,
    messageThreadId: row.message_thread_id,
    sessionId: row.session_id ?? "",
    createdAt: row.created_at,
    name: row.name,
    agent,
    agentSettings: parseAgentSettings(row.agent_settings),
    ...(row.cron_session_id && { cronSessionId: row.cron_session_id }),
    ...(row.description && { description: row.description }),
    ...(row.model && { model: row.model }),
    ...(row.cwd && { cwd: row.cwd }),
    ...(row.effort && { effort: row.effort }),
    ...(row.fork_origin && { forkOrigin: row.fork_origin }),
  };
}

/** Close DB cleanly on shutdown — checkpoints WAL back into main DB file */
export function flushSessionCache() {
  db.close();
}

// --- Helpers for JSON array/object columns ---

function parseGroupIds(raw: string): number[] {
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

function parseGroupTitles(raw: string): Record<string, string> {
  try { const obj = JSON.parse(raw); return typeof obj === "object" && obj !== null ? obj : {}; } catch { return {}; }
}

// --- User config ---

/** Get user's forum config — topics are shared across users within this server (not filtered by user_id) */
export function getUserConfig(userId: number): UserForumConfig | null {
  const user = db.query<UserRow, string>("SELECT * FROM users WHERE id = ?").get(String(userId));
  if (!user) return null;

  const topicRows = db.query<TopicRow, string>(
    "SELECT * FROM topics WHERE server_name = ?"
  ).all(SERVER_NAME);
  const topics: { [name: string]: ForumTopicInfo } = {};
  for (const row of topicRows) {
    topics[row.name] = rowToTopic(row);
  }

  return {
    forumGroupIds: parseGroupIds(user.forum_group_ids),
    forumGroupTitles: parseGroupTitles(user.forum_group_titles),
    ...(user.dm_session_id && { dmSessionId: user.dm_session_id }),
    ...(user.communicate_thread_id != null && { communicateThreadId: user.communicate_thread_id }),
    topics,
  };
}

/** Get the list of forum group IDs for a user */
export function getForumGroupIds(userId: number): number[] {
  const row = db.query<{ forum_group_ids: string }, string>(
    "SELECT forum_group_ids FROM users WHERE id = ?"
  ).get(String(userId));
  return row ? parseGroupIds(row.forum_group_ids) : [];
}

/** Check if a user has a specific forum group connected */
export function hasForumGroup(userId: number, groupId: number): boolean {
  return getForumGroupIds(userId).includes(groupId);
}

/** Find the first user who has this group connected. Returns userId or null. */
export function findUserByGroupId(groupId: number): number | null {
  const rows = db.query<{ id: string; forum_group_ids: string }, []>(
    "SELECT id, forum_group_ids FROM users"
  ).all();
  for (const row of rows) {
    if (parseGroupIds(row.forum_group_ids).includes(groupId)) return Number(row.id);
  }
  return null;
}

/** Add a forum group to user's group list. Returns true if newly added. */
export function addForumGroup(userId: number, groupId: number, groupTitle?: string): boolean {
  const existing = db.query<{ forum_group_ids: string; forum_group_titles: string }, string>(
    "SELECT forum_group_ids, forum_group_titles FROM users WHERE id = ?"
  ).get(String(userId));

  if (!existing) {
    const ids = JSON.stringify([groupId]);
    const titles = JSON.stringify({ [String(groupId)]: groupTitle || "" });
    db.query("INSERT INTO users (id, forum_group_ids, forum_group_titles) VALUES (?, ?, ?)").run(
      String(userId), ids, titles
    );
    return true;
  }

  const ids = parseGroupIds(existing.forum_group_ids);
  const titles = parseGroupTitles(existing.forum_group_titles);

  if (ids.includes(groupId)) {
    // Already connected — just update title
    titles[String(groupId)] = groupTitle || titles[String(groupId)] || "";
    db.query("UPDATE users SET forum_group_titles = ? WHERE id = ?").run(
      JSON.stringify(titles), String(userId)
    );
    return false;
  }

  ids.push(groupId);
  titles[String(groupId)] = groupTitle || "";
  db.query("UPDATE users SET forum_group_ids = ?, forum_group_titles = ? WHERE id = ?").run(
    JSON.stringify(ids), JSON.stringify(titles), String(userId)
  );
  logger.info({ userId, groupId, groupTitle }, "Forum group added");
  return true;
}

/** Remove a forum group from user's group list. Topics are shared, so they're only dropped when no other user has the group connected. */
export function removeForumGroup(userId: number, groupId: number): boolean {
  const existing = db.query<{ forum_group_ids: string; forum_group_titles: string }, string>(
    "SELECT forum_group_ids, forum_group_titles FROM users WHERE id = ?"
  ).get(String(userId));
  if (!existing) return false;

  const ids = parseGroupIds(existing.forum_group_ids);
  const titles = parseGroupTitles(existing.forum_group_titles);

  const idx = ids.indexOf(groupId);
  if (idx === -1) return false;

  ids.splice(idx, 1);
  delete titles[String(groupId)];

  db.transaction(() => {
    db.query("UPDATE users SET forum_group_ids = ?, forum_group_titles = ? WHERE id = ?").run(
      JSON.stringify(ids), JSON.stringify(titles), String(userId)
    );
    // Check if any other user still has this group; if not, topics are orphaned and we clean them up.
    const otherUsers = db.query<{ forum_group_ids: string }, []>(
      "SELECT forum_group_ids FROM users"
    ).all();
    const stillConnected = otherUsers.some(u => parseGroupIds(u.forum_group_ids).includes(groupId));
    if (!stillConnected) {
      db.query("DELETE FROM topics WHERE server_name = ? AND forum_group_id = ?").run(SERVER_NAME, groupId);
    }
  })();

  logger.info({ userId, groupId }, "Forum group removed");
  _onGroupRemoveListener?.(userId, groupId);
  return true;
}

// --- Topic management ---

/** Add a topic. user_id is recorded as creator metadata; uniqueness is (server_name, forum_group_id, name). */
export function addTopic(userId: number, groupId: number, name: string, messageThreadId: number, sessionId?: string, createdAt?: string) {
  // Ensure user exists
  db.query(`INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING`).run(String(userId));

  db.query(`
    INSERT INTO topics (user_id, forum_group_id, name, message_thread_id, session_id, created_at, server_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_name, forum_group_id, name) DO UPDATE SET
      message_thread_id = excluded.message_thread_id,
      session_id = excluded.session_id,
      created_at = excluded.created_at
  `).run(String(userId), groupId, name, messageThreadId, sessionId ?? null, createdAt ?? new Date().toISOString(), SERVER_NAME);
}

/** Remove a topic by name (any creator) */
export function removeTopic(name: string) {
  db.query("DELETE FROM topics WHERE server_name = ? AND name = ?").run(SERVER_NAME, name);
}

/** Get topic by name (this server only) */
export function getTopicByName(name: string): ForumTopicInfo | null {
  const row = db.query<TopicRow, [string, string]>(
    "SELECT * FROM topics WHERE name = ? AND server_name = ?"
  ).get(name, SERVER_NAME);
  return row ? rowToTopic(row) : null;
}

/** Get the userId who owns a topic (this server only). */
export function getTopicUserId(name: string): number | null {
  const row = db.query<{ user_id: string }, [string, string]>(
    "SELECT user_id FROM topics WHERE name = ? AND server_name = ?"
  ).get(name, SERVER_NAME);
  return row ? Number(row.user_id) : null;
}

/** Get topic by thread ID (this server only) */
export function getTopicByThreadId(threadId: number): ForumTopicInfo | null {
  const row = db.query<TopicRow, [number, string]>(
    "SELECT * FROM topics WHERE message_thread_id = ? AND server_name = ?"
  ).get(threadId, SERVER_NAME);
  return row ? rowToTopic(row) : null;
}

/** Reverse lookup: find user by group ID and thread ID — only matches topics owned by this server. */
export function findUserByGroupAndThread(groupId: number, threadId: number): { userId: number; topic: ForumTopicInfo } | null {
  const row = db.query<TopicRow, [number, number, string]>(
    "SELECT * FROM topics WHERE forum_group_id = ? AND message_thread_id = ? AND server_name = ?"
  ).get(groupId, threadId, SERVER_NAME);
  if (!row) return null;
  return { userId: Number(row.user_id), topic: rowToTopic(row) };
}

/** Get session ID for a topic */
export function getSessionForTopic(topicName: string): string | null {
  const row = db.query<{ session_id: string | null }, [string, string]>(
    "SELECT session_id FROM topics WHERE server_name = ? AND name = ?"
  ).get(SERVER_NAME, topicName);
  return row?.session_id || null;
}

/** Get cron session ID for a topic */
export function getCronSessionForTopic(topicName: string): string | null {
  const row = db.query<{ cron_session_id: string | null }, [string, string]>(
    "SELECT cron_session_id FROM topics WHERE server_name = ? AND name = ?"
  ).get(SERVER_NAME, topicName);
  return row?.cron_session_id || null;
}

/** Set cron session ID for a topic */
export function setCronSessionForTopic(topicName: string, sessionId: string) {
  db.query("UPDATE topics SET cron_session_id = ? WHERE server_name = ? AND name = ?").run(
    sessionId, SERVER_NAME, topicName
  );
}

/** Set session ID for a topic */
export function setSessionForTopic(topicName: string, sessionId: string) {
  db.query("UPDATE topics SET session_id = ? WHERE server_name = ? AND name = ?").run(
    sessionId, SERVER_NAME, topicName
  );
}

/** Clear session ID for a topic */
export function clearSessionForTopic(topicName: string) {
  db.query("UPDATE topics SET session_id = NULL WHERE server_name = ? AND name = ?").run(
    SERVER_NAME, topicName
  );
}

/** Get all topic names in this server */
export function getTopicNames(): string[] {
  const rows = db.query<{ name: string }, string>(
    "SELECT name FROM topics WHERE server_name = ?"
  ).all(SERVER_NAME);
  return rows.map(r => r.name);
}

/** Get all topic names for a specific group (this server only) */
export function getTopicNamesForGroup(groupId: number): string[] {
  const rows = db.query<{ name: string }, [string, number]>(
    "SELECT name FROM topics WHERE server_name = ? AND forum_group_id = ?"
  ).all(SERVER_NAME, groupId);
  return rows.map(r => r.name);
}

/** Generate a link to a forum topic */
export function getTopicLink(groupId: number, messageThreadId: number): string {
  const numericId = String(groupId).replace(/^-100/, "");
  return `https://t.me/c/${numericId}/${messageThreadId}`;
}

/** Get communicate topic thread ID */
export function getCommunicateThreadId(userId: number): number | null {
  const row = db.query<{ communicate_thread_id: number | null }, string>(
    "SELECT communicate_thread_id FROM users WHERE id = ?"
  ).get(String(userId));
  return row?.communicate_thread_id ?? null;
}

/** Clear communicate topic thread ID */
export function clearCommunicateThreadId(userId: number) {
  db.query("UPDATE users SET communicate_thread_id = NULL WHERE id = ?").run(String(userId));
}

/** Set communicate topic thread ID */
export function setCommunicateThreadId(userId: number, threadId: number) {
  db.query("UPDATE users SET communicate_thread_id = ? WHERE id = ?").run(threadId, String(userId));
}

/** Get DM session ID */
export function getDmSessionId(userId: number): string | null {
  const row = db.query<{ dm_session_id: string | null }, string>(
    "SELECT dm_session_id FROM users WHERE id = ?"
  ).get(String(userId));
  return row?.dm_session_id ?? null;
}

/** Set DM session ID — creates user if not exists */
export function setDmSessionId(userId: number, sessionId: string) {
  db.query(`
    INSERT INTO users (id, forum_group_ids, dm_session_id) VALUES (?, '[]', ?)
    ON CONFLICT(id) DO UPDATE SET dm_session_id = excluded.dm_session_id
  `).run(String(userId), sessionId);
}

/** Clear DM session ID */
export function clearDmSessionId(userId: number) {
  db.query("UPDATE users SET dm_session_id = NULL WHERE id = ?").run(String(userId));
}

/** Get topic description */
export function getTopicDescription(topicName: string): string | null {
  const row = db.query<{ description: string | null }, [string, string]>(
    "SELECT description FROM topics WHERE server_name = ? AND name = ?"
  ).get(SERVER_NAME, topicName);
  return row?.description || null;
}

const MODEL_ALIAS: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

/** Get topic model (resolves aliases) */
export function getTopicModel(topicName: string): string | null {
  const row = db.query<{ model: string | null }, [string, string]>(
    "SELECT model FROM topics WHERE server_name = ? AND name = ?"
  ).get(SERVER_NAME, topicName);
  const raw = row?.model ?? null;
  if (!raw) return null;
  return MODEL_ALIAS[raw] || raw;
}

/** Set topic model */
export function setTopicModel(topicName: string, model: string | null): boolean {
  const result = db.query("UPDATE topics SET model = ? WHERE server_name = ? AND name = ?").run(
    model, SERVER_NAME, topicName
  );
  return result.changes > 0;
}

/** Set topic description */
export function setTopicDescription(topicName: string, description: string): boolean {
  const result = db.query("UPDATE topics SET description = ? WHERE server_name = ? AND name = ?").run(
    description, SERVER_NAME, topicName
  );
  return result.changes > 0;
}

/** Get topic cwd */
export function getTopicCwd(topicName: string): string | null {
  const row = db.query<{ cwd: string | null }, [string, string]>(
    "SELECT cwd FROM topics WHERE server_name = ? AND name = ?"
  ).get(SERVER_NAME, topicName);
  return row?.cwd || null;
}

/** Set topic cwd */
export function setTopicCwd(topicName: string, cwd: string | null): boolean {
  const result = db.query("UPDATE topics SET cwd = ? WHERE server_name = ? AND name = ?").run(
    cwd, SERVER_NAME, topicName
  );
  return result.changes > 0;
}

/** Get topic effort level */
export function getTopicEffort(topicName: string): EffortLevel | null {
  const row = db.query<{ effort: EffortLevel | null }, [string, string]>(
    "SELECT effort FROM topics WHERE server_name = ? AND name = ?"
  ).get(SERVER_NAME, topicName);
  return row?.effort ?? null;
}

/** Set topic effort level */
export function setTopicEffort(topicName: string, effort: EffortLevel | null): boolean {
  const result = db.query("UPDATE topics SET effort = ? WHERE server_name = ? AND name = ?").run(
    effort, SERVER_NAME, topicName
  );
  return result.changes > 0;
}

/** Update topic's message_thread_id (used when recreating topics) */
export function updateTopicThreadId(topicName: string, newThreadId: number, groupId: number) {
  db.query("UPDATE topics SET message_thread_id = ?, forum_group_id = ? WHERE server_name = ? AND name = ?").run(
    newThreadId, groupId, SERVER_NAME, topicName
  );
}

/** Get all topics in this server */
export function getAllTopics(): ForumTopicInfo[] {
  const rows = db.query<TopicRow, string>(
    "SELECT * FROM topics WHERE server_name = ?"
  ).all(SERVER_NAME);
  return rows.map(rowToTopic);
}

/** Get all topics for a specific group (this server only) */
export function getAllTopicsForGroup(groupId: number): ForumTopicInfo[] {
  const rows = db.query<TopicRow, [string, number]>(
    "SELECT * FROM topics WHERE server_name = ? AND forum_group_id = ?"
  ).all(SERVER_NAME, groupId);
  return rows.map(rowToTopic);
}

/** Get MCP config for a topic */
export function getTopicMcpConfig(topicName: string): { enabled: string[] | null; extra: Record<string, unknown> } {
  const row = db.query<{ mcp_enabled: string | null; mcp_extra: string | null }, [string, string]>(
    "SELECT mcp_enabled, mcp_extra FROM topics WHERE server_name = ? AND name = ?"
  ).get(SERVER_NAME, topicName);
  return {
    enabled: row?.mcp_enabled ? JSON.parse(row.mcp_enabled) : null,
    extra: row?.mcp_extra ? JSON.parse(row.mcp_extra) : {},
  };
}

/** Set enabled MCP server names for a topic */
export function setTopicMcpEnabled(topicName: string, enabled: string[] | null): boolean {
  const result = db.query("UPDATE topics SET mcp_enabled = ? WHERE server_name = ? AND name = ?").run(
    enabled !== null ? JSON.stringify(enabled) : null, SERVER_NAME, topicName
  );
  return result.changes > 0;
}

/** Set extra MCP server configs for a topic */
export function setTopicMcpExtra(topicName: string, extra: Record<string, unknown>): boolean {
  const result = db.query("UPDATE topics SET mcp_extra = ? WHERE server_name = ? AND name = ?").run(
    JSON.stringify(extra), SERVER_NAME, topicName
  );
  return result.changes > 0;
}

/** Set fork origin for a topic (points to the root parent of a fork chain). */
export function setTopicForkOrigin(topicName: string, origin: string): boolean {
  const result = db.query("UPDATE topics SET fork_origin = ? WHERE server_name = ? AND name = ?").run(
    origin, SERVER_NAME, topicName
  );
  return result.changes > 0;
}

/** Get the active agent for a topic. Defaults to 'claude' for legacy rows. */
export function getTopicAgent(topicName: string): AgentKind {
  const row = db.query<{ agent: string | null }, [string, string]>(
    "SELECT agent FROM topics WHERE server_name = ? AND name = ?"
  ).get(SERVER_NAME, topicName);
  if (!row) return FALLBACK_AGENT;
  return isAgentKind(row.agent) ? row.agent : FALLBACK_AGENT;
}

/** Set the active agent for a topic. Also clears session_id and model (model is agent-specific). */
export function setTopicAgent(topicName: string, agent: AgentKind): boolean {
  const result = db.query(
    "UPDATE topics SET agent = ?, session_id = NULL, model = NULL WHERE server_name = ? AND name = ?"
  ).run(agent, SERVER_NAME, topicName);
  return result.changes > 0;
}

/** Get the full agent_settings JSON for a topic. */
export function getTopicAgentSettings(topicName: string): AgentSettings {
  const row = db.query<{ agent_settings: string | null }, [string, string]>(
    "SELECT agent_settings FROM topics WHERE server_name = ? AND name = ?"
  ).get(SERVER_NAME, topicName);
  return parseAgentSettings(row?.agent_settings ?? null);
}

/** Update agent_settings for a topic. */
export function setTopicAgentSettings(topicName: string, settings: AgentSettings): boolean {
  const result = db.query(
    "UPDATE topics SET agent_settings = ? WHERE server_name = ? AND name = ?"
  ).run(JSON.stringify(settings), SERVER_NAME, topicName);
  return result.changes > 0;
}

/** Get the last-shown agent/model/effort footer config for a topic. */
export function getLastShownConfig(topicName: string): {
  agent: AgentKind | null;
  model: string | null;
  effort: string | null;
} | null {
  const row = db.query<{
    last_shown_agent: string | null;
    last_shown_model: string | null;
    last_shown_effort: string | null;
  }, [string, string]>(
    "SELECT last_shown_agent, last_shown_model, last_shown_effort FROM topics WHERE server_name = ? AND name = ?"
  ).get(SERVER_NAME, topicName);
  if (!row) return null;
  const agent = row.last_shown_agent && isAgentKind(row.last_shown_agent)
    ? row.last_shown_agent
    : null;
  return { agent, model: row.last_shown_model, effort: row.last_shown_effort };
}

/** Update the last-shown footer config for a topic. */
export function setLastShownConfig(
  topicName: string,
  agent: AgentKind,
  model: string,
  effort: string | undefined,
): boolean {
  const result = db.query(
    "UPDATE topics SET last_shown_agent = ?, last_shown_model = ?, last_shown_effort = ? WHERE server_name = ? AND name = ?"
  ).run(agent, model, effort ?? null, SERVER_NAME, topicName);
  return result.changes > 0;
}
