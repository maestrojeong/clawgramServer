import {
  SEND_FILE_SERVER, SESSION_COMM_SERVER, CRON_MANAGER_SERVER, CRON_DM_SERVER,
  DM_MANAGER_SERVER, TOKEN_STATS_SERVER,
} from "@/core/config";

// --- Common MCP servers (shared across DM and forum sessions) ---

function getCommonMcpServers(userId: string) {
  return {
    "send-file":            { command: "bun", args: ["run", SEND_FILE_SERVER, `--user-id=${userId}`] },
    "token-stats":          { command: "bun", args: ["run", TOKEN_STATS_SERVER, `--user-id=${userId}`] },
  };
}

// --- Session-type-specific builders ---

/** DM session: dm-manager + cron-dm admin */
export function getDmMcpServers(opts: { userId: string }) {
  const { userId } = opts;
  return {
    ...getCommonMcpServers(userId),
    "dm-manager": { command: "bun", args: ["run", DM_MANAGER_SERVER, `--user-id=${userId}`] },
    "cron-dm": { command: "bun", args: ["run", CRON_DM_SERVER, `--user-id=${userId}`] },
  };
}

/** All default forum MCP server names (for reference in configure_mcp) */
export const ALL_FORUM_MCP_SERVER_NAMES = [
  "send-file", "token-stats", "session-comm", "cron-manager",
] as const;

/** Always-on MCP servers — cannot be removed via enabled whitelist */
export const REQUIRED_FORUM_MCP_SERVERS = ["session-comm", "send-file", "cron-manager"] as const;

/** Forum session: session-comm + cron-manager */
export function getForumMcpServers(opts: {
  userId: string;
  session: string;
  depth?: number;
  chain?: string[];
  enabled?: string[] | null;  // null = all defaults, string[] = whitelist
  extra?: Record<string, unknown>;
}) {
  const { userId, session, depth = 0, chain = [session], enabled = null, extra = {} } = opts;
  const all: Record<string, unknown> = {
    ...getCommonMcpServers(userId),
    "session-comm": {
      command: "bun",
      args: ["run", SESSION_COMM_SERVER, `--user-id=${userId}`, `--topic=${session}`, `--depth=${depth}`, `--chain=${JSON.stringify(chain)}`],
    },
    "cron-manager": {
      command: "bun",
      args: ["run", CRON_MANAGER_SERVER, `--user-id=${userId}`, `--topic=${session}`],
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

/** Fork session (orchestrate/delegate_to_session): minimal — session-comm only */
export function getForkMcpServers(opts: { userId: string; topic: string; depth: number; chain: string[] }) {
  const { userId, topic, depth, chain } = opts;
  return {
    "session-comm": {
      command: "bun",
      args: ["run", SESSION_COMM_SERVER, `--user-id=${userId}`, `--topic=${topic}`, `--depth=${depth}`, `--chain=${JSON.stringify(chain)}`],
    },
  };
}
