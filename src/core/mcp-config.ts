import { resolve } from "node:path";
import {
  SEND_FILE_SERVER, SESSION_COMM_SERVER, CRON_MANAGER_SERVER, CRON_DM_SERVER,
  DM_MANAGER_SERVER, TOKEN_STATS_SERVER, TOPIC_MANAGER_SERVER, TOPIC_SELF_CONFIG_SERVER,
  BUN_BIN, PLAYWRIGHT_MCP_BIN, PLAYWRIGHT_PROFILES_DIR,
} from "@/core/config";
import type { AgentQueryOptions } from "@/core/types";

// --- Playwright transport builders ---

function playwrightStdio(userId: string, topic: string) {
  const userDataDir = resolve(PLAYWRIGHT_PROFILES_DIR, `user_${userId}/${topic}`);
  return {
    command: PLAYWRIGHT_MCP_BIN,
    args: ["--user-data-dir", userDataDir],
  };
}

function playwrightSSE(port: number) {
  return {
    type: "sse" as const,
    url: `http://localhost:${port}/sse`,
  };
}

function playwrightEntry(userId: string, topic: string, port?: number) {
  return port ? playwrightSSE(port) : playwrightStdio(userId, topic);
}

// --- Common MCP servers (shared across DM and forum sessions) ---

function getCommonMcpServers(userId: string, topic: string, playwrightPort?: number) {
  return {
    "playwright":           playwrightEntry(userId, topic, playwrightPort),
    "send-file":            { command: BUN_BIN, args: ["run", SEND_FILE_SERVER, `--user-id=${userId}`, `--topic=${topic}`] },
    "token-stats":          { command: BUN_BIN, args: ["run", TOKEN_STATS_SERVER, `--user-id=${userId}`] },
  };
}

// --- Session-type-specific builders ---

/** DM session: dm-manager + cron-dm admin + topic-manager */
export function getDmMcpServers(opts: { userId: string; groupId?: number; playwrightPort?: number }) {
  const { userId, groupId, playwrightPort } = opts;
  const groupArg = groupId ? [`--group-id=${groupId}`] : [];
  return {
    ...getCommonMcpServers(userId, "dm", playwrightPort),
    "dm-manager": { command: BUN_BIN, args: ["run", DM_MANAGER_SERVER, `--user-id=${userId}`] },
    "cron-dm": { command: BUN_BIN, args: ["run", CRON_DM_SERVER, `--user-id=${userId}`] },
    "topic-manager": { command: BUN_BIN, args: ["run", TOPIC_MANAGER_SERVER, `--user-id=${userId}`, ...groupArg] },
  };
}

/** All default forum MCP server names (for reference in configure_mcp) */
export const ALL_FORUM_MCP_SERVER_NAMES = [
  "playwright", "send-file", "token-stats", "session-comm", "cron-manager", "topic-self-config",
] as const;

/** Always-on MCP servers — cannot be removed via enabled whitelist */
export const REQUIRED_FORUM_MCP_SERVERS = ["session-comm", "send-file", "cron-manager", "topic-self-config"] as const;

/** Forum session: session-comm + cron-manager.
 *  `depth` = current tell_session chain depth (0 = from user).
 *  `silent` = pass --reply-only=true so the session-comm MCP suppresses outbound tools
 *  (ask/tell/abort). Used for ask_session reply forks. */
export function getForumMcpServers(opts: {
  userId: string;
  session: string;
  depth?: number;
  silent?: boolean;
  enabled?: string[] | null;  // null = all defaults, string[] = whitelist
  extra?: Record<string, unknown>;
  playwrightPort?: number;
}) {
  const { userId, session, depth = 0, silent = false, enabled = null, extra = {}, playwrightPort } = opts;
  const all: Record<string, unknown> = {
    ...getCommonMcpServers(userId, session, playwrightPort),
    "session-comm": {
      command: BUN_BIN,
      args: [
        "run", SESSION_COMM_SERVER,
        `--user-id=${userId}`,
        `--topic=${session}`,
        `--depth=${depth}`,
        ...(silent ? ["--reply-only=true"] : []),
      ],
    },
    "cron-manager": {
      command: BUN_BIN,
      args: ["run", CRON_MANAGER_SERVER, `--user-id=${userId}`, `--topic=${session}`],
    },
    "topic-self-config": {
      command: BUN_BIN,
      args: ["run", TOPIC_SELF_CONFIG_SERVER, `--user-id=${userId}`, `--topic=${session}`],
    },
  };

  // null = load all defaults; string[] = whitelist (required servers always included).
  // Playwright is opt-in even when "null" because spawning a browser costs RAM —
  // forum topics must explicitly include "playwright" in their enabled list.
  const base = enabled !== null
    ? Object.fromEntries(Object.entries(all).filter(([k]) =>
        enabled.includes(k) || (REQUIRED_FORUM_MCP_SERVERS as readonly string[]).includes(k)
      ))
    : Object.fromEntries(Object.entries(all).filter(([k]) => k !== "playwright"));

  return { ...base, ...extra };
}

/**
 * Unified MCP server builder for agent providers.
 * Routes to the right server set based on sessionType.
 */
export function getMcpServersForQuery(opts: AgentQueryOptions): Record<string, unknown> {
  if (opts.sessionType === "dm") {
    return getDmMcpServers({
      userId: opts.userId || "default",
      groupId: opts.groupId,
      playwrightPort: opts.playwrightPort,
    });
  }
  return getForumMcpServers({
    userId: opts.userId || "default",
    session: opts.session || "default",
    depth: opts.depth,
    silent: opts.silent,
    enabled: opts.mcpEnabled,
    extra: opts.mcpExtra,
    playwrightPort: opts.playwrightPort,
  });
}

/** Fork session (ask_cron fork): minimal — session-comm only */
export function getForkMcpServers(opts: { userId: string; topic: string; depth: number }) {
  const { userId, topic, depth } = opts;
  return {
    "session-comm": {
      command: BUN_BIN,
      args: ["run", SESSION_COMM_SERVER, `--user-id=${userId}`, `--topic=${topic}`, `--depth=${depth}`],
    },
  };
}
