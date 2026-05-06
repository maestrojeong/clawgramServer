#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync, readFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, copyFileSync } from "fs";
import { join, basename, dirname } from "path";
import { Database } from "bun:sqlite";
import { USERS_LOG_DIR, SESSIONS_DB, DM_CMD_DIR, DM_RESP_DIR, DEBUG_FILE, SERVER_NAME, withTopicPrefix } from "@/core/config";

// Parse CLI args
const args = process.argv.slice(2);
const userId = args.find((a) => a.startsWith("--user-id="))?.split("=")[1] || "";

// --- SQLite helpers ---

interface TopicEntry {
  sessionId: string;
  messageThreadId: number;
  forumGroupId: number;
  name: string;
  createdAt: string;
  description?: string;
  model?: string;
  cwd?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  agent?: string;
  mcpEnabled?: string[] | null;
  mcpExtra?: Record<string, unknown>;
}

interface UserConfig {
  forumGroupIds: number[];
  forumGroupTitles: Record<string, string>;
  dmSessionId?: string;
  topics: { [name: string]: TopicEntry };
}

function getUserConfig(): UserConfig | null {
  if (!existsSync(SESSIONS_DB)) return null;
  const db = new Database(SESSIONS_DB, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    const user = db.query<{
      forum_group_ids: string | null;
      forum_group_titles: string | null;
      dm_session_id: string | null;
    }, string>("SELECT forum_group_ids, forum_group_titles, dm_session_id FROM users WHERE id = ?").get(userId);
    if (!user) return null;

    let forumGroupIds: number[] = [];
    let forumGroupTitles: Record<string, string> = {};
    if (user.forum_group_ids) try { forumGroupIds = JSON.parse(user.forum_group_ids); } catch { /* empty */ }
    if (user.forum_group_titles) try { forumGroupTitles = JSON.parse(user.forum_group_titles); } catch { /* empty */ }

    const topicRows = db.query<{
      name: string;
      message_thread_id: number;
      forum_group_id: number;
      session_id: string | null;
      created_at: string;
      description: string | null;
      model: string | null;
      cwd: string | null;
      effort: string | null;
      agent: string | null;
      mcp_enabled: string | null;
      mcp_extra: string | null;
    }, string>("SELECT name, message_thread_id, forum_group_id, session_id, created_at, description, model, cwd, effort, agent, mcp_enabled, mcp_extra FROM topics WHERE server_name = ?").all(SERVER_NAME);

    const topics: { [name: string]: TopicEntry } = {};
    for (const row of topicRows) {
      let mcpEnabled: string[] | null | undefined;
      let mcpExtra: Record<string, unknown> | undefined;
      // Each field parsed independently — one corrupt value must not discard the others
      if (row.mcp_enabled != null) try { mcpEnabled = JSON.parse(row.mcp_enabled); } catch (e) { process.stderr.write(`warn: Failed to parse mcp_enabled for "${row.name}": ${e}\n`); }
      if (row.mcp_extra)     try { mcpExtra = JSON.parse(row.mcp_extra); } catch (e) { process.stderr.write(`warn: Failed to parse mcp_extra for "${row.name}": ${e}\n`); }
      topics[row.name] = {
        name: row.name,
        messageThreadId: row.message_thread_id,
        forumGroupId: row.forum_group_id,
        sessionId: row.session_id ?? "",
        createdAt: row.created_at,
        ...(row.description && { description: row.description }),
        ...(row.model && { model: row.model }),
        ...(row.cwd && { cwd: row.cwd }),
        ...(row.effort && { effort: row.effort as TopicEntry['effort'] }),
        ...(row.agent && { agent: row.agent }),
        ...(mcpEnabled !== undefined && { mcpEnabled }),
        ...(mcpExtra !== undefined && { mcpExtra }),
      };
    }

    return {
      forumGroupIds,
      forumGroupTitles,
      ...(user.dm_session_id && { dmSessionId: user.dm_session_id }),
      topics,
    };
  } finally {
    db.close();
  }
}

// --- Outbox pattern for Telegram API operations ---

interface DmCommand {
  requestId: string;
  action: string;
  params: Record<string, unknown>;
  timestamp: string;
}

function writeCommand(cmd: DmCommand) {
  const file = join(DM_CMD_DIR, `${userId}.jsonl`);
  appendFileSync(file, JSON.stringify(cmd) + "\n");
}

function waitForResponse(requestId: string, timeoutMs = 15000): Promise<Record<string, unknown>> {
  const respFile = join(DM_RESP_DIR, `${userId}-${requestId}.json`);
  const start = Date.now();

  return new Promise((resolve, reject) => {
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const check = () => {
      if (existsSync(respFile)) {
        clearTimeout(timerId);
        try {
          const data = JSON.parse(readFileSync(respFile, "utf-8"));
          unlinkSync(respFile);
          resolve(data);
        } catch (e) {
          reject(e);
        }
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearTimeout(timerId);
        reject(new Error("Timeout waiting for bot response"));
        return;
      }
      timerId = setTimeout(check, 500);
    };
    check();
  });
}

function genRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Debug helpers ---

function loadDebugUsers(): Set<string> {
  try {
    if (existsSync(DEBUG_FILE)) {
      const arr = JSON.parse(readFileSync(DEBUG_FILE, "utf-8"));
      return new Set(arr);
    }
  } catch (e) { process.stderr.write(`warn: Failed to load debug users: ${e}\n`); }
  return new Set();
}

function saveDebugUsers(users: Set<string>) {
  writeFileSync(DEBUG_FILE, JSON.stringify([...users], null, 2));
}

// --- All topics (cross-user) ---

function getAllTopics(): { forumGroupTitles: Record<string, string>; topics: TopicEntry[] } | null {
  if (!existsSync(SESSIONS_DB)) return null;
  const db = new Database(SESSIONS_DB, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    const userRows = db.query<{ id: string; forum_group_titles: string | null }, []>(
      "SELECT id, forum_group_titles FROM users"
    ).all();
    const titleMap: Record<string, string> = {};
    for (const u of userRows) {
      if (u.forum_group_titles) {
        try { const t = JSON.parse(u.forum_group_titles); Object.assign(titleMap, t); } catch { /* empty */ }
      }
    }
    const topicRows = db.query<{
      name: string; message_thread_id: number; forum_group_id: number;
      session_id: string | null; created_at: string; description: string | null;
      model: string | null; cwd: string | null; effort: string | null; agent: string | null;
    }, string>("SELECT name, message_thread_id, forum_group_id, session_id, created_at, description, model, cwd, effort, agent FROM topics WHERE server_name = ? ORDER BY forum_group_id, name").all(SERVER_NAME);

    const topics: TopicEntry[] = topicRows.map((row) => ({
      name: row.name,
      messageThreadId: row.message_thread_id,
      forumGroupId: row.forum_group_id,
      sessionId: row.session_id ?? "",
      createdAt: row.created_at,
      ...(row.description && { description: row.description }),
      ...(row.model && { model: row.model }),
      ...(row.cwd && { cwd: row.cwd }),
      ...(row.effort && { effort: row.effort as TopicEntry['effort'] }),
      ...(row.agent && { agent: row.agent }),
    }));
    return { forumGroupTitles: titleMap, topics };
  } finally { db.close(); }
}

// --- MCP Server ---

const server = new McpServer({
  name: "dm-manager",
  version: "1.0.0",
});

server.tool(
  "list_topics",
  "List all forum topics (Claude sessions) across all groups with their status, cwd, model, and effort.",
  {},
  async () => {
    const config = getUserConfig();
    if (!config || config.forumGroupIds.length === 0) {
      return {
        content: [{ type: "text" as const, text: "STATUS: NOT_CONNECTED\nNo forum group linked. Guide the user through onboarding to connect one." }],
      };
    }

    const all = getAllTopics();
    if (!all || all.topics.length === 0) {
      const groupList = config.forumGroupIds.map((gid) => {
        const title = config.forumGroupTitles[String(gid)] || gid;
        return `  - ${title} (${gid})`;
      }).join("\n");
      return {
        content: [{ type: "text" as const, text: `STATUS: CONNECTED\nGroups:\n${groupList}\n\nNo topics yet. Use create_topic to create one.` }],
      };
    }

    // Group topics by forum group
    const grouped = new Map<number, typeof all.topics>();
    for (const t of all.topics) {
      const arr = grouped.get(t.forumGroupId) ?? [];
      arr.push(t);
      grouped.set(t.forumGroupId, arr);
    }

    // Ensure current user's empty groups appear in the listing
    for (const gid of config.forumGroupIds) {
      if (!grouped.has(gid)) grouped.set(gid, []);
    }

    const sections: string[] = [];
    for (const [gid, topics] of grouped) {
      const groupTitle = all.forumGroupTitles[String(gid)] || String(gid);
      if (topics.length === 0) {
        sections.push(`Group: ${groupTitle}\n    group_id: ${gid}\n  (no topics)`);
        continue;
      }
      const lines = topics.map((t) => {
        const status = t.sessionId ? `active` : "new";
        const agent = ` [${t.agent ?? "claude"}]`;
        const model = t.model ? ` [${t.model}]` : " [default]";
        const effort = t.effort ? ` effort:${t.effort}` : "";
        const cwdLine = t.cwd ? `\n      cwd: ${t.cwd}` : "";
        const desc = t.description ? `\n      desc: ${t.description.slice(0, 80)}${t.description.length > 80 ? "..." : ""}` : "";
        return `  - ${t.name} (thread:${t.messageThreadId})\n      status: ${status}${agent}${model}${effort}${cwdLine}${desc}`;
      });
      sections.push(`Group: ${groupTitle}\n    group_id: ${gid}\n${lines.join("\n")}`);
    }

    return {
      content: [{
        type: "text" as const,
        text: `STATUS: CONNECTED\n\n${sections.join("\n\n")}`,
      }],
    };
  }
);

server.tool(
  "create_topic",
  "Create a new forum topic (Claude session). Infer and set appropriate MCP servers, model, and effort based on the topic's purpose.",
  {
    name: z.string().describe("Topic name (e.g. 'law', 'research', 'coding')"),
    group_id: z.number().optional().describe("Target forum group ID. If user has multiple groups, specify which one. Omit to use the first connected group."),
    purpose: z.string().optional().describe("Brief description of what this topic is for — used to infer appropriate settings"),
    mcp_enabled: z.array(z.string()).nullable().optional().describe(
      "MCP servers to enable. null = all defaults. Available: send-file, token-stats, session-comm, cron-manager"
    ),
    cwd: z.string().optional().describe("Working directory for this topic's Claude session (e.g. '~/projects/my-app'). Defaults to ~/ if not specified."),
    model: z.enum(["sonnet", "opus", "haiku"]).optional().describe("Claude model. Infer from purpose: complex reasoning → opus; general → sonnet; simple tasks → haiku"),
    effort: z.enum(["low", "medium", "high", "max"]).optional().describe("Effort level. Infer from purpose: research/analysis → high; quick tasks → low; default → omit"),
  },
  async ({ name, group_id, purpose: _purpose, mcp_enabled, cwd, model, effort }) => {
    const config = getUserConfig();
    if (!config || config.forumGroupIds.length === 0) {
      return {
        content: [{ type: "text" as const, text: "Error: No forum group linked. User must run /connect in a forum group first." }],
        isError: true,
      };
    }

    if (config.topics[withTopicPrefix(name)]) {
      return {
        content: [{ type: "text" as const, text: `Error: Topic "${name}" already exists.` }],
        isError: true,
      };
    }

    const requestId = genRequestId();
    writeCommand({
      requestId,
      action: "create_topic",
      params: { name, group_id, mcp_enabled, cwd, model, effort },
      timestamp: new Date().toISOString(),
    });

    try {
      const resp = await waitForResponse(requestId);
      if (resp.success) {
        return {
          content: [{ type: "text" as const, text: `Topic "${name}" created.\nLink: ${resp.link || ""}` }],
        };
      }
      return {
        content: [{ type: "text" as const, text: `Error creating topic: ${resp.error || "unknown"}` }],
        isError: true,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "delete_topic",
  "Delete a forum topic (Claude session). This removes the topic from the Telegram forum group.",
  {
    name: z.string().describe("Topic name to delete"),
  },
  async ({ name }) => {
    const config = getUserConfig();
    if (!config?.topics[withTopicPrefix(name)]) {
      return {
        content: [{ type: "text" as const, text: `Error: Topic "${name}" not found.` }],
        isError: true,
      };
    }

    const requestId = genRequestId();
    writeCommand({
      requestId,
      action: "delete_topic",
      params: { name },
      timestamp: new Date().toISOString(),
    });

    try {
      const resp = await waitForResponse(requestId);
      if (resp.success) {
        return {
          content: [{ type: "text" as const, text: `Topic "${name}" deleted.` }],
        };
      }
      return {
        content: [{ type: "text" as const, text: `Error deleting topic: ${resp.error || "unknown"}` }],
        isError: true,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "set_description",
  "Set a description for a specific topic. Acts as a system prompt addition — describes what the session is about and customizes Claude's behavior. Shown in list_topics for routing context.",
  {
    topic: z.string().describe("Topic name"),
    description: z.string().describe("Description / system prompt (e.g. 'You are a legal research specialist.')"),
  },
  async ({ topic, description }) => {
    const config = getUserConfig();
    if (!config?.topics[withTopicPrefix(topic)]) {
      return {
        content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found.` }],
        isError: true,
      };
    }

    const requestId = genRequestId();
    writeCommand({ requestId, action: "set_description", params: { topic, description }, timestamp: new Date().toISOString() });

    try {
      const resp = await waitForResponse(requestId);
      if (resp.success) {
        return {
          content: [{
            type: "text" as const,
            text: `Description set for "${topic}".\n\nNote: Takes effect on the next new message in that topic.`,
          }],
        };
      }
      return {
        content: [{ type: "text" as const, text: `Error setting description: ${resp.error || "unknown"}` }],
        isError: true,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_description",
  "Get the current description for a specific topic.",
  {
    topic: z.string().describe("Topic name"),
  },
  async ({ topic }) => {
    const config = getUserConfig();
    const t = config?.topics[withTopicPrefix(topic)];
    if (!t) {
      return {
        content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found.` }],
        isError: true,
      };
    }

    const extra = t.description;
    if (!extra) {
      return {
        content: [{ type: "text" as const, text: `Topic "${topic}" has no description set.` }],
      };
    }

    return {
      content: [{ type: "text" as const, text: `Topic "${topic}" description:\n\n${extra}` }],
    };
  }
);

server.tool(
  "set_topic_model",
  "Set the Claude model for a specific topic. Use 'sonnet' for fast/cheap tasks, 'opus' for complex reasoning, 'haiku' for simple tasks. Set to 'default' to clear and use the system default.",
  {
    topic: z.string().describe("Topic name"),
    model: z.enum(["sonnet", "opus", "haiku", "default"]).describe("Model to use: sonnet, opus, haiku, or default"),
  },
  async ({ topic, model }) => {
    const config = getUserConfig();
    if (!config?.topics[withTopicPrefix(topic)]) {
      return {
        content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found.` }],
        isError: true,
      };
    }

    const requestId = genRequestId();
    writeCommand({ requestId, action: "set_topic_model", params: { topic, model }, timestamp: new Date().toISOString() });

    try {
      const resp = await waitForResponse(requestId);
      if (resp.success) {
        const display = model === "default" ? "system default" : model;
        return {
          content: [{
            type: "text" as const,
            text: `Model set to "${display}" for topic "${topic}".\n\nNote: The model change takes effect on the next message in that topic.`,
          }],
        };
      }
      return {
        content: [{ type: "text" as const, text: `Error setting model: ${resp.error || "unknown"}` }],
        isError: true,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_topic_model",
  "Get the current Claude model setting for a specific topic.",
  {
    topic: z.string().describe("Topic name"),
  },
  async ({ topic }) => {
    const config = getUserConfig();
    const t = config?.topics[withTopicPrefix(topic)];
    if (!t) {
      return {
        content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found.` }],
        isError: true,
      };
    }

    const model = t.model || "default (system)";
    return {
      content: [{ type: "text" as const, text: `Topic "${topic}" model: ${model}` }],
    };
  }
);

server.tool(
  "set_topic_cwd",
  "Set the working directory for a topic's Claude session. Use '~' prefix for home directory paths.",
  {
    topic: z.string().describe("Topic name"),
    cwd: z.string().nullable().describe("Working directory path (e.g. '~/projects/my-app'). null to reset to default (~/)."),
  },
  async ({ topic, cwd }) => {
    const config = getUserConfig();
    if (!config?.topics[withTopicPrefix(topic)]) {
      return {
        content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found.` }],
        isError: true,
      };
    }

    const requestId = genRequestId();
    writeCommand({ requestId, action: "set_topic_cwd", params: { topic, cwd }, timestamp: new Date().toISOString() });

    try {
      const resp = await waitForResponse(requestId);
      if (resp.success) {
        const display = cwd || "~/ (default)";
        return {
          content: [{
            type: "text" as const,
            text: `Working directory set to "${display}" for topic "${topic}".\n\nNote: Takes effect on the next message.`,
          }],
        };
      }
      return {
        content: [{ type: "text" as const, text: `Error setting cwd: ${resp.error || "unknown"}` }],
        isError: true,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_topic_cwd",
  "Get the current working directory for a topic's Claude session.",
  {
    topic: z.string().describe("Topic name"),
  },
  async ({ topic }) => {
    const config = getUserConfig();
    const t = config?.topics[withTopicPrefix(topic)];
    if (!t) {
      return {
        content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found.` }],
        isError: true,
      };
    }

    const cwd = t.cwd || "~/ (default)";
    return {
      content: [{ type: "text" as const, text: `Topic "${topic}" working directory: ${cwd}` }],
    };
  }
);

server.tool(
  "set_topic_effort",
  "Set the effort level for a specific topic. Controls how much thinking/reasoning Claude applies. 'low' is fastest and cheapest, 'high' is the default, 'max' is Opus 4.6 only. Use 'default' to clear and use the system default.",
  {
    topic: z.string().describe("Topic name"),
    effort: z.enum(["low", "medium", "high", "max", "default"]).describe("Effort level: low, medium, high, max, or default"),
  },
  async ({ topic, effort }) => {
    const config = getUserConfig();
    if (!config?.topics[withTopicPrefix(topic)]) {
      return {
        content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found.` }],
        isError: true,
      };
    }

    const requestId = genRequestId();
    writeCommand({ requestId, action: "set_topic_effort", params: { topic, effort }, timestamp: new Date().toISOString() });

    try {
      const resp = await waitForResponse(requestId);
      if (resp.success) {
        const display = effort === "default" ? "system default (high)" : effort;
        return {
          content: [{
            type: "text" as const,
            text: `Effort level set to "${display}" for topic "${topic}".\n\nNote: Takes effect on the next message in that topic.`,
          }],
        };
      }
      return {
        content: [{ type: "text" as const, text: `Error setting effort: ${resp.error || "unknown"}` }],
        isError: true,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_topic_effort",
  "Get the current effort level setting for a specific topic.",
  {
    topic: z.string().describe("Topic name"),
  },
  async ({ topic }) => {
    const config = getUserConfig();
    const t = config?.topics[withTopicPrefix(topic)];
    if (!t) {
      return {
        content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found.` }],
        isError: true,
      };
    }

    const effort = t.effort || "default (high)";
    return {
      content: [{ type: "text" as const, text: `Topic "${topic}" effort level: ${effort}` }],
    };
  }
);

server.tool(
  "get_topic_mcp_config",
  "Get the current MCP server configuration for a specific topic.",
  {
    topic: z.string().describe("Topic name"),
  },
  async ({ topic }) => {
    const config = getUserConfig();
    const t = config?.topics[withTopicPrefix(topic)];
    if (!t) {
      return { content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found.` }], isError: true };
    }
    const defaultServers = ["send-file", "token-stats", "session-comm", "cron-manager"];
    const active = (t.mcpEnabled !== undefined && t.mcpEnabled !== null) ? t.mcpEnabled : defaultServers;
    const extra = t.mcpExtra ?? {};
    const lines = [
      `Topic: ${topic}`,
      ``,
      `활성 서버: ${active.length > 0 ? active.join(", ") : "없음"}`,
      `설정 방식: ${t.mcpEnabled !== undefined ? "whitelist" : "기본값 (전체)"}`,
      `추가 서버: ${Object.keys(extra).length > 0 ? Object.keys(extra).join(", ") : "없음"}`,
      ``,
      `전체 기본 서버: ${defaultServers.join(", ")}`,
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.tool(
  "set_topic_mcp_enabled",
  "Set which MCP servers are active for a topic. Default servers: send-file, token-stats, session-comm, cron-manager.",
  {
    topic: z.string().describe("Topic name"),
    enabled: z.array(z.string()).nullable().describe("Server names to enable. null = restore all defaults, [] = none, or list specific names e.g. [\"session-comm\",\"send-file\"]"),
  },
  async ({ topic, enabled }) => {
    const config = getUserConfig();
    if (!config?.topics[withTopicPrefix(topic)]) {
      return { content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found.` }], isError: true };
    }
    const requestId = genRequestId();
    writeCommand({ requestId, action: "set_topic_mcp_enabled", params: { topic, enabled }, timestamp: new Date().toISOString() });
    try {
      const resp = await waitForResponse(requestId);
      if (resp.success) {
        const display = enabled === null ? "기본값 (전체)" : enabled.length > 0 ? enabled.join(", ") : "없음";
        return { content: [{ type: "text" as const, text: `Topic "${topic}" MCP 서버 설정: ${display}\n\n다음 세션부터 적용됩니다.` }] };
      }
      return { content: [{ type: "text" as const, text: `Error: ${resp.error || "unknown"}` }], isError: true };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "set_topic_mcp_extra",
  "Set extra (custom) MCP server configs for a topic. Each entry is a server name → config object.",
  {
    topic: z.string().describe("Topic name"),
    extra: z.record(z.string(), z.any()).describe("Custom MCP server configs (e.g. { \"slack\": { command: \"bun\", args: [\"run\", \"/path/to/server.ts\"] } }). Pass {} to clear all extra servers."),
  },
  async ({ topic, extra }) => {
    const config = getUserConfig();
    if (!config?.topics[withTopicPrefix(topic)]) {
      return { content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found.` }], isError: true };
    }
    const requestId = genRequestId();
    writeCommand({ requestId, action: "set_topic_mcp_extra", params: { topic, extra }, timestamp: new Date().toISOString() });
    try {
      const resp = await waitForResponse(requestId);
      if (resp.success) {
        const keys = Object.keys(extra as object);
        return { content: [{ type: "text" as const, text: `Topic "${topic}" extra MCP servers set: ${keys.length > 0 ? keys.join(", ") : "없음 (cleared)"}\n\n다음 세션부터 적용됩니다.` }] };
      }
      return { content: [{ type: "text" as const, text: `Error: ${resp.error || "unknown"}` }], isError: true };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "set_topic_agent",
  "Switch the agent backend for a specific topic between 'claude' (Claude Code SDK / Anthropic) and 'codex' (Codex SDK / OpenAI). The session resets so the new backend starts fresh on the next message. Use only when the user explicitly asks to switch agents.",
  {
    topic: z.string().describe("Topic name"),
    agent: z.enum(["claude", "codex"]).describe("Agent backend: 'claude' or 'codex'"),
  },
  async ({ topic, agent }) => {
    const config = getUserConfig();
    if (!config?.topics[withTopicPrefix(topic)]) {
      return { content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found.` }], isError: true };
    }
    const requestId = genRequestId();
    writeCommand({ requestId, action: "set_topic_agent", params: { topic, agent }, timestamp: new Date().toISOString() });
    try {
      const resp = await waitForResponse(requestId);
      if (resp.success) {
        return { content: [{ type: "text" as const, text: `Agent for "${topic}" switched to '${agent}'.\n\n다음 메시지부터 적용됩니다.` }] };
      }
      return { content: [{ type: "text" as const, text: `Error: ${resp.error || "unknown"}` }], isError: true };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "get_topic_agent",
  "Get the current agent backend ('claude' or 'codex') for a specific topic.",
  {
    topic: z.string().describe("Topic name"),
  },
  async ({ topic }) => {
    const config = getUserConfig();
    const t = config?.topics[withTopicPrefix(topic)];
    if (!t) {
      return { content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found.` }], isError: true };
    }
    return { content: [{ type: "text" as const, text: `Topic "${topic}" agent: ${t.agent ?? "claude"}` }] };
  }
);

server.tool(
  "toggle_debug",
  "Toggle debug mode on/off. When on, intermediate thinking/tool use details are shown in Telegram messages.",
  {},
  async () => {
    const users = loadDebugUsers();
    if (users.has(userId)) {
      users.delete(userId);
      saveDebugUsers(users);
      return {
        content: [{ type: "text" as const, text: "Debug mode OFF — intermediate details will be hidden." }],
      };
    } else {
      users.add(userId);
      saveDebugUsers(users);
      return {
        content: [{ type: "text" as const, text: "Debug mode ON — intermediate thinking/tool details will be shown." }],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
