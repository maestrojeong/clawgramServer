import { resolve, dirname } from "path";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { fileURLToPath } from "url";

const HOME = homedir();

// new URL("../..", import.meta.url) causes webpack to treat "../.." as a module import.
// Split into fileURLToPath → dirname → resolve to avoid that.
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function resolveClaudeExecutable(): string {
  if (process.env.CLAUDE_EXECUTABLE_PATH) return process.env.CLAUDE_EXECUTABLE_PATH;
  const candidates = [
    resolve(HOME, ".local/bin/claude"),
    resolve(HOME, ".npm-global/bin/claude"),
    resolve(HOME, ".npm/bin/claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

export const CLAUDE_EXECUTABLE = resolveClaudeExecutable();

// pm2 환경에서 PATH에 없을 수 있으므로 절대경로 사용
export const BUN_BIN = resolve(HOME, ".bun/bin/bun");

// --- Server identity ---
// SERVER_NAME identifies this bot instance among other bots/servers sharing the same
// supergroups. Used as a [prefix] on all forum topic names so each server can tell which
// topics belong to it. Required: bot exits at startup if missing.
export const SERVER_NAME = (process.env.SERVER_NAME || "").trim();

/** Returns the prefix used to tag topics owned by this server, e.g. "[mac1] ". */
export function topicPrefix(): string {
  return `[${SERVER_NAME}] `;
}

/** Prepends the server prefix to a topic name if not already present. */
export function withTopicPrefix(name: string): string {
  const p = topicPrefix();
  return name.startsWith(p) ? name : `${p}${name}`;
}

export const SEND_FILE_SERVER = resolve(PROJECT_ROOT, "src/mcp/send-file-server.ts");

export const SESSION_COMM_SERVER = resolve(PROJECT_ROOT, "src/mcp/session-comm-server.ts");

export const CRON_MANAGER_SERVER = resolve(PROJECT_ROOT, "src/mcp/cron/manager-server.ts");

export const CRON_DM_SERVER = resolve(PROJECT_ROOT, "src/mcp/cron/dm-server.ts");

export const DM_MANAGER_SERVER = resolve(PROJECT_ROOT, "src/mcp/dm-manager-server.ts");

export const TOKEN_STATS_SERVER = resolve(PROJECT_ROOT, "src/mcp/token-stats-server.ts");

export const TOPIC_SELF_CONFIG_SERVER = resolve(PROJECT_ROOT, "src/mcp/topic/self-config-server.ts");

export const TOPIC_MANAGER_SERVER = resolve(PROJECT_ROOT, "src/mcp/topic/manager-server.ts");

export const META_DIR = resolve(PROJECT_ROOT, "meta");

// Persistent state (survives restarts, long-lived)
export const DATA_DIR = resolve(PROJECT_ROOT, "data");
export const SESSIONS_DB = resolve(DATA_DIR, "sessions.db");
export const DEBUG_FILE = resolve(DATA_DIR, "debug-users.json");
export const USERS_LOG_DIR = resolve(DATA_DIR, "users");

// Runtime IPC queues (transient, safe to clear on restart)
export const RUN_DIR = resolve(PROJECT_ROOT, "run");
export const PROGRESS_DIR = resolve(RUN_DIR, "progress");
export const DM_CMD_DIR = resolve(RUN_DIR, "dm-commands");
export const DM_RESP_DIR = resolve(RUN_DIR, "dm-responses");
export const SESSION_INBOX_DIR = resolve(RUN_DIR, "session-inbox");
export const PLAYWRIGHT_PORTS_DIR = resolve(RUN_DIR, "playwright-ports");
mkdirSync(PROGRESS_DIR, { recursive: true });
mkdirSync(DM_CMD_DIR, { recursive: true });
mkdirSync(DM_RESP_DIR, { recursive: true });
mkdirSync(SESSION_INBOX_DIR, { recursive: true });
mkdirSync(PLAYWRIGHT_PORTS_DIR, { recursive: true });

// --- Playwright MCP ---
export const PLAYWRIGHT_PROFILES_DIR = resolve(DATA_DIR, "playwright");
export const PLAYWRIGHT_MCP_BIN = resolve(PROJECT_ROOT, "node_modules/.bin/playwright-mcp");

function parsePortEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
}
export const PLAYWRIGHT_BASE_PORT = parsePortEnv(process.env.PLAYWRIGHT_BASE_PORT, 9100);
export const PLAYWRIGHT_MAX_PORT = parsePortEnv(process.env.PLAYWRIGHT_MAX_PORT, 9499);

/** Stale threshold for active-query state files (crash recovery) */
export const ACTIVE_QUERY_STALE_MS = 10 * 60 * 1000; // 10 minutes


const PROMPTS_DIR = resolve(PROJECT_ROOT, "src/core/prompts");
export const AGENTS_PROMPTS_DIR = resolve(PROMPTS_DIR, "agents");
const SESSIONS_DIR = resolve(PROMPTS_DIR, "sessions");
const RESOURCES_DIR = resolve(PROJECT_ROOT, "src/core/resources");

function loadPrompt(filename: string, dir = SESSIONS_DIR): string {
  const raw = readFileSync(resolve(dir, filename), "utf-8");
  return raw
    .replace(/\{\{RESOURCES_DIR\}\}/g, RESOURCES_DIR);
}

export interface AgentDef {
  name: string;
  type: "autonomous" | "programmatic";
  model?: string;
  tools?: string[];
  description?: string;
  prompt: string;
}

export function loadAgentPrompt(filename: string): AgentDef {
  const raw = readFileSync(resolve(AGENTS_PROMPTS_DIR, filename), "utf-8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`Agent prompt ${filename} is missing frontmatter`);

  // Minimal YAML parser: supports scalar values and string arrays (2-space "  - item" lists).
  // Empty lines are skipped explicitly — without the guard they'd match the scalar branch
  // and reset currentKey, silently truncating any list that follows.
  const meta: Record<string, unknown> = {};
  let currentKey: string | null = null;
  for (const line of match[1].split("\n")) {
    if (/^\w[^:]*:$/.test(line)) {
      currentKey = line.trim().replace(/:$/, "");
      meta[currentKey] = [];
    } else if (line.startsWith("  - ") && currentKey) {
      (meta[currentKey] as string[]).push(line.slice(4).trim());
    } else if (line.trim() !== "" && line.includes(":") && !line.startsWith(" ")) {
      currentKey = null;
      const colonIdx = line.indexOf(":");
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key && value) meta[key] = value;
    }
  }

  return {
    name: String(meta.name ?? filename.replace(".md", "")),
    type: (meta.type as AgentDef["type"]) ?? "programmatic",
    model: meta.model ? String(meta.model) : undefined,
    tools: Array.isArray(meta.tools) ? meta.tools as string[] : undefined,
    description: meta.description ? String(meta.description) : undefined,
    prompt: match[2].trim(),
  };
}

// --- Model constants ---
export const MODEL_SONNET = "claude-sonnet-4-6";
export const MODEL_OPUS = "claude-opus-4-7";
export const MODEL_HAIKU = "claude-haiku-4-5-20251001";
export const ADVISOR_MODEL = MODEL_OPUS;

export const SYSTEM_PROMPT = loadPrompt("topic-system.md");
export const DM_SYSTEM_PROMPT = loadPrompt("dm-system.md");

export function buildTopicSystemPrompt(opts?: {
  description?: string | null;
}): string {
  let prompt = SYSTEM_PROMPT;
  if (opts?.description) {
    prompt += "\n\n## Topic-Specific Instructions\n" + opts.description;
  }
  return prompt;
}

/** Returns process.env without CLAUDECODE, to prevent nested claude-code detection in subprocesses. */
export function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

// MCP server builders → src/core/mcp-config.ts
