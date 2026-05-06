import {
  SEND_FILE_SERVER, SESSION_COMM_SERVER, CRON_MANAGER_SERVER, CRON_DM_SERVER,
  DM_MANAGER_SERVER, TOKEN_STATS_SERVER, TOPIC_MANAGER_SERVER, TOPIC_SELF_CONFIG_SERVER,
  BUN_BIN,
} from "@/core/config";
import type { AgentQueryOptions } from "@/core/types";

// --- Common MCP servers (shared across DM and forum sessions) ---

function getCommonMcpServers(userId: string) {
  return {
    "send-file":            { command: BUN_BIN, args: ["run", SEND_FILE_SERVER, `--user-id=${userId}`] },
    "token-stats":          { command: BUN_BIN, args: ["run", TOKEN_STATS_SERVER, `--user-id=${userId}`] },
  };
}

// --- Session-type-specific builders ---

/** DM session: dm-manager + cron-dm admin + topic-manager */
export function getDmMcpServers(opts: { userId: string; groupId?: number }) {
  const { userId, groupId } = opts;
  const groupArg = groupId ? [`--group-id=${groupId}`] : [];
  return {
    ...getCommonMcpServers(userId),
    "dm-manager": { command: BUN_BIN, args: ["run", DM_MANAGER_SERVER, `--user-id=${userId}`] },
    "cron-dm": { command: BUN_BIN, args: ["run", CRON_DM_SERVER, `--user-id=${userId}`] },
    "topic-manager": { command: BUN_BIN, args: ["run", TOPIC_MANAGER_SERVER, `--user-id=${userId}`, ...groupArg] },
  };
}

/** All default forum MCP server names (for reference in configure_mcp) */
export const ALL_FORUM_MCP_SERVER_NAMES = [
  "send-file", "token-stats", "session-comm", "cron-manager", "topic-self-config",
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
}) {
  const { userId, session, depth = 0, silent = false, enabled = null, extra = {} } = opts;
  const all: Record<string, unknown> = {
    ...getCommonMcpServers(userId),
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

  // null = load all defaults; string[] = whitelist (required servers always included)
  const base = enabled !== null
    ? Object.fromEntries(Object.entries(all).filter(([k]) =>
        enabled.includes(k) || (REQUIRED_FORUM_MCP_SERVERS as readonly string[]).includes(k)
      ))
    : all;

  return { ...base, ...extra };
}

/**
 * Unified MCP server builder for agent providers.
 * Routes to the right server set based on sessionType.
 */
export function getMcpServersForQuery(opts: AgentQueryOptions): Record<string, unknown> {
  if (opts.sessionType === "dm" || opts.sessionType === "ephemeral") {
    return getDmMcpServers({ userId: opts.userId || "default", groupId: opts.groupId });
  }
  return getForumMcpServers({
    userId: opts.userId || "default",
    session: opts.session || "default",
    depth: opts.depth,
    silent: opts.silent,
    enabled: opts.mcpEnabled,
    extra: opts.mcpExtra,
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
