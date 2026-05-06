#!/usr/bin/env node
/**
 * Manager-scope admin MCP server. Loaded by the DM manager agent.
 * Every tool here operates on forum topics in the connected group — never on
 * the manager session itself. Tool descriptions phrase the target as "topic" /
 * "a specific topic" so the model resolves the parameter explicitly via
 * list_topics instead of inferring "the current chat".
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRegistry } from "@/core/agents/registry";
import { SUPPORTED_AGENTS } from "@/core/agents";
import { SESSIONS_DB, DEBUG_FILE } from "@/core/config";
import { errMsg } from "@/core/error";
import type { AgentKind } from "@/core/types";
import { genRequestId, waitForResponse, writeCommand } from "@/mcp/dm-ipc";
import { connectStdio, mcpError, mcpOk, parseGroupIdArg, parseUserIdArg } from "@/mcp/mcp-helpers";
import {
  getAllTopicsForGroup,
  getUserConfig,
  findUserByGroupId,
} from "@/telegram/forum-sessions";

const args = process.argv.slice(2);
const userIdStr = parseUserIdArg(args);
const userId = Number(userIdStr);
const groupId = parseGroupIdArg(args);

const server = new McpServer({ name: "topic-manager", version: "1.0.0" });

const AGENT_VALUES = SUPPORTED_AGENTS as readonly AgentKind[];

interface TopicSummary {
  name: string;
  sessionId: string;
  agent: AgentKind;
  model?: string;
  effort?: string;
  description?: string;
  mcpEnabled?: string[] | null;
}

function getMcpUserConfig(): { forumGroupId: number; forumGroupTitle?: string; topics: Record<string, TopicSummary> } | null {
  if (!existsSync(SESSIONS_DB)) return null;
  if (!groupId) {
    process.stderr.write(`warn: topic-manager: called without --group-id (user=${userId}); returning null\n`);
    return null;
  }

  // Verify the user owns this group
  const ownerUserId = findUserByGroupId(groupId);
  if (!ownerUserId) return null;

  const config = getUserConfig(ownerUserId);
  if (!config || !config.forumGroupIds.includes(groupId)) return null;

  const topics = getAllTopicsForGroup(groupId);
  const topicMap: Record<string, TopicSummary> = {};
  for (const t of topics) {
    topicMap[t.name] = {
      name: t.name,
      sessionId: t.sessionId,
      agent: t.agent,
      ...(t.model && { model: t.model }),
      ...(t.effort && { effort: t.effort }),
      ...(t.description && { description: t.description }),
    };
  }

  const title = config.forumGroupTitles[String(groupId)];
  return {
    forumGroupId: groupId,
    ...(title && { forumGroupTitle: title }),
    topics: topicMap,
  };
}

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

server.tool(
  "list_topics",
  "List all forum topics (Claude/Codex sessions) for the user with their status and settings.",
  {},
  async () => {
    const config = getMcpUserConfig();
    if (!config) {
      return mcpOk(
        "STATUS: NOT_CONNECTED\nNo forum group linked or group-id not provided. Guide the user through onboarding — promoting the bot to administrator in a forum supergroup auto-connects it.",
      );
    }

    if (Object.keys(config.topics).length === 0) {
      return mcpOk(
        `STATUS: CONNECTED\nGroup: ${config.forumGroupTitle || config.forumGroupId}\n\nNo topics yet. Use create_topic to create one.`,
      );
    }

    const lines = Object.entries(config.topics).map(([name, t]) => {
      const status = t.sessionId ? `active (${t.sessionId.slice(0, 8)})` : "new";
      const agent = ` [${t.agent}]`;
      const model = t.model ? ` [${t.model}]` : " [default]";
      const effort = t.effort ? ` [effort:${t.effort}]` : "";
      const desc = t.description
        ? `\n    description: ${t.description.slice(0, 80)}${t.description.length > 80 ? "..." : ""}`
        : "";
      const mcpStr =
        t.mcpEnabled !== undefined
          ? `\n    mcp: [${t.mcpEnabled ? t.mcpEnabled.join(", ") : "none"}]`
          : "";
      return `- ${name}: ${status}${agent}${model}${effort}${desc}${mcpStr}`;
    });

    const groupTitle = config.forumGroupTitle || String(config.forumGroupId);
    return mcpOk(
      `STATUS: CONNECTED\nGroup: ${groupTitle}\n\nTopics (${lines.length}):\n${lines.join("\n")}`,
    );
  },
);

server.tool(
  "create_topic",
  "Create a new forum topic (Claude/Codex session). Infer MCP servers from the topic's purpose. Leave model/effort unset (system defaults) unless the user explicitly requests a specific value.",
  {
    name: z.string().describe("Topic name (e.g. 'law', 'research', 'coding')"),
    purpose: z
      .string()
      .optional()
      .describe("Brief description of what this topic is for — used to infer appropriate MCP servers"),
    mcp_enabled: z
      .array(z.string())
      .nullable()
      .optional()
      .describe(
        "MCP servers to enable. null = all defaults. Infer from purpose: e.g. coding/text → ['session-comm','cron-manager','send-file','token-stats']. Available: send-file, token-stats, session-comm, cron-manager",
      ),
    model: z
      .enum(["sonnet", "opus", "haiku"])
      .optional()
      .describe("Claude model. Omit unless the user explicitly asked. Options: sonnet, opus, haiku"),
    effort: z
      .enum(["low", "medium", "high", "xhigh", "max"])
      .optional()
      .describe("Effort level. Omit unless the user explicitly asked."),
  },
  async ({ name, purpose: _purpose, mcp_enabled, model, effort }) => {
    const config = getMcpUserConfig();
    if (!config) {
      return mcpError(
        "Error: No forum group linked or group-id not provided. Bot must be promoted to administrator in a forum supergroup (auto-connects on promotion).",
      );
    }
    if (config.topics[name]) {
      return mcpError(`Error: Topic "${name}" already exists.`);
    }

    const requestId = genRequestId();
    writeCommand(String(userId), {
      requestId,
      action: "create_topic",
      params: { name, mcp_enabled, model, effort, group_id: groupId || undefined },
      timestamp: new Date().toISOString(),
    });

    try {
      const resp = await waitForResponse(String(userId), requestId);
      if (resp.success) return mcpOk(`Topic "${name}" created.\nLink: ${resp.link || ""}`);
      return mcpError(`Error creating topic: ${resp.error || "unknown"}`);
    } catch (err) {
      return mcpError(`Error: ${errMsg(err)}`);
    }
  },
);

server.tool(
  "delete_topic",
  "Delete a forum topic (Claude/Codex session). This removes the topic from the Telegram forum group.",
  {
    name: z.string().describe("Topic name to delete"),
  },
  async ({ name }) => {
    const config = getMcpUserConfig();
    if (!config?.topics[name]) {
      return mcpError(`Error: Topic "${name}" not found.`);
    }

    const requestId = genRequestId();
    writeCommand(String(userId), {
      requestId,
      action: "delete_topic",
      params: { name, group_id: groupId || undefined },
      timestamp: new Date().toISOString(),
    });

    try {
      const resp = await waitForResponse(String(userId), requestId);
      if (resp.success) return mcpOk(`Topic "${name}" deleted.`);
      return mcpError(`Error deleting topic: ${resp.error || "unknown"}`);
    } catch (err) {
      return mcpError(`Error: ${errMsg(err)}`);
    }
  },
);

server.tool(
  "set_description",
  "Set a description for a specific topic. Acts as a system prompt addition — describes what the session is about and customizes Claude's behavior. Shown in list_topics for routing context.",
  {
    topic: z.string().describe("Topic name"),
    description: z
      .string()
      .describe("Description / system prompt (e.g. 'You are a legal research specialist.')"),
  },
  async ({ topic, description }) => {
    const config = getMcpUserConfig();
    if (!config?.topics[topic]) return mcpError(`Error: Topic "${topic}" not found.`);

    const requestId = genRequestId();
    writeCommand(String(userId), {
      requestId,
      action: "set_description",
      params: { topic, description, group_id: groupId || undefined },
      timestamp: new Date().toISOString(),
    });

    try {
      const resp = await waitForResponse(String(userId), requestId);
      if (resp.success) {
        return mcpOk(
          `Description set for "${topic}".\n\nNote: Takes effect on the next new message in that topic.`,
        );
      }
      return mcpError(`Error setting description: ${resp.error || "unknown"}`);
    } catch (err) {
      return mcpError(`Error: ${errMsg(err)}`);
    }
  },
);

server.tool(
  "get_description",
  "Get the current description for a specific topic.",
  {
    topic: z.string().describe("Topic name"),
  },
  async ({ topic }) => {
    const config = getMcpUserConfig();
    if (!config?.topics[topic]) return mcpError(`Error: Topic "${topic}" not found.`);
    const desc = config.topics[topic].description;
    if (!desc) return mcpOk(`Topic "${topic}" has no description set.`);
    return mcpOk(`Topic "${topic}" description:\n\n${desc}`);
  },
);

server.tool(
  "set_topic_model",
  "Set the model for a specific topic. For Claude topics: use 'sonnet' / 'opus' / 'haiku'. For Codex topics: use the OpenAI model id ('gpt-5.5', 'gpt-5', 'o3', etc.). Set to 'default' to clear and fall back to the agent's default. The model name must be valid for the topic's current agent backend.",
  {
    topic: z.string().describe("Topic name"),
    model: z
      .string()
      .describe("Model id. Claude: 'sonnet' / 'opus' / 'haiku'. Codex: any OpenAI model id. Use 'default' to clear."),
  },
  async ({ topic, model }) => {
    const config = getMcpUserConfig();
    if (!config?.topics[topic]) return mcpError(`Error: Topic "${topic}" not found.`);
    if (model !== "default") {
      const agent = config.topics[topic].agent;
      const registry = getRegistry(agent);
      if (!registry.validateModel(model)) {
        return mcpError(`Error: model '${model}' is not valid for agent '${agent}' on topic "${topic}".`);
      }
    }

    const requestId = genRequestId();
    writeCommand(String(userId), {
      requestId,
      action: "set_topic_model",
      params: { topic, model, group_id: groupId || undefined },
      timestamp: new Date().toISOString(),
    });

    try {
      const resp = await waitForResponse(String(userId), requestId);
      if (resp.success) {
        const display = model === "default" ? "system default" : model;
        return mcpOk(
          `Model set to "${display}" for topic "${topic}".\n\nNote: The model change takes effect on the next message in that topic.`,
        );
      }
      return mcpError(`Error setting model: ${resp.error || "unknown"}`);
    } catch (err) {
      return mcpError(`Error: ${errMsg(err)}`);
    }
  },
);

server.tool(
  "get_topic_model",
  "Get the current model setting for a specific topic.",
  {
    topic: z.string().describe("Topic name"),
  },
  async ({ topic }) => {
    const config = getMcpUserConfig();
    if (!config?.topics[topic]) return mcpError(`Error: Topic "${topic}" not found.`);
    const agentKind = config.topics[topic].agent;
    const registry = getRegistry(agentKind);
    const model = config.topics[topic].model ?? `default (${registry.defaultModel})`;
    return mcpOk(`Topic "${topic}" model (agent=${agentKind}): ${model}`);
  },
);

server.tool(
  "set_topic_effort",
  "Set the effort (reasoning depth) for a specific topic. Valid values depend on the topic's agent: Claude topics accept low/medium/high/xhigh/max; Codex topics accept minimal/low/medium/high/xhigh. 'default' clears the override and falls back to the system default. Takes effect on the next message in that topic.",
  {
    topic: z.string().describe("Topic name"),
    effort: z
      .enum(["minimal", "low", "medium", "high", "xhigh", "max", "default"])
      .describe("Effort level or 'default' to clear."),
  },
  async ({ topic, effort }) => {
    const config = getMcpUserConfig();
    const topicInfo = config?.topics[topic];
    if (!topicInfo) return mcpError(`Error: Topic "${topic}" not found.`);
    if (effort !== "default") {
      const registry = getRegistry(topicInfo.agent);
      if (!registry.validateEffort(effort as never)) {
        return mcpError(
          `Effort '${effort}' is not valid for agent '${topicInfo.agent}' on topic "${topic}". Valid: ${registry.validEfforts.join(", ")}.`,
        );
      }
    }

    const requestId = genRequestId();
    writeCommand(String(userId), {
      requestId,
      action: "set_topic_effort",
      params: { topic, effort, group_id: groupId || undefined },
      timestamp: new Date().toISOString(),
    });

    try {
      const resp = await waitForResponse(String(userId), requestId);
      if (resp.success) {
        const registry = getRegistry(topicInfo.agent);
        const fallback = registry.defaultEffort
          ? `agent default (${registry.defaultEffort})`
          : "agent default (none — reasoning off)";
        const display = effort === "default" ? fallback : effort;
        return mcpOk(
          `Effort level set to "${display}" for topic "${topic}".\n\nNote: Takes effect on the next message in that topic.`,
        );
      }
      return mcpError(`Error setting effort: ${resp.error || "unknown"}`);
    } catch (err) {
      return mcpError(`Error: ${errMsg(err)}`);
    }
  },
);

server.tool(
  "get_topic_effort",
  "Get the current effort level setting for a specific topic.",
  {
    topic: z.string().describe("Topic name"),
  },
  async ({ topic }) => {
    const config = getMcpUserConfig();
    if (!config?.topics[topic]) return mcpError(`Error: Topic "${topic}" not found.`);
    const agentKind = config.topics[topic].agent;
    const registry = getRegistry(agentKind);
    const fallback = registry.defaultEffort
      ? `default (${registry.defaultEffort})`
      : "default (none — reasoning off)";
    const effort = config.topics[topic].effort || fallback;
    return mcpOk(`Topic "${topic}" effort level (agent=${agentKind}): ${effort}`);
  },
);

server.tool(
  "set_topic_agent",
  "Switch the agent backend for a specific topic between 'claude' (Claude Code SDK / Anthropic) and 'codex' (Codex SDK / OpenAI). The session resets so the new backend starts fresh on the next message. Use only when the user explicitly asks to switch agents.",
  {
    topic: z.string().describe("Topic name"),
    agent: z
      .enum(AGENT_VALUES as unknown as [AgentKind, ...AgentKind[]])
      .describe("Agent backend: 'claude' or 'codex'"),
  },
  async ({ topic, agent }) => {
    const config = getMcpUserConfig();
    if (!config?.topics[topic]) return mcpError(`Error: Topic "${topic}" not found.`);

    const requestId = genRequestId();
    writeCommand(String(userId), {
      requestId,
      action: "set_topic_agent",
      params: { topic, agent, group_id: groupId || undefined },
      timestamp: new Date().toISOString(),
    });

    try {
      const resp = await waitForResponse(String(userId), requestId);
      if (resp.success) {
        return mcpOk(
          `Agent for "${topic}" switched to '${agent}'.\n\nApplies from the next message in that topic.`,
        );
      }
      return mcpError(`Error setting agent: ${resp.error || "unknown"}`);
    } catch (err) {
      return mcpError(`Error: ${errMsg(err)}`);
    }
  },
);

server.tool(
  "get_topic_agent",
  "Get the current agent backend ('claude' or 'codex') for a specific topic.",
  {
    topic: z.string().describe("Topic name"),
  },
  async ({ topic }) => {
    const config = getMcpUserConfig();
    const t = config?.topics[topic];
    if (!t) return mcpError(`Error: Topic "${topic}" not found.`);
    return mcpOk(`Topic "${topic}" agent: ${t.agent}`);
  },
);

server.tool(
  "toggle_debug",
  "Toggle debug mode on/off. When on, intermediate thinking/tool use details are shown in Telegram messages.",
  {},
  async () => {
    const users = loadDebugUsers();
    if (users.has(String(userId))) {
      users.delete(String(userId));
      saveDebugUsers(users);
      return mcpOk("Debug mode OFF — intermediate details will be hidden.");
    } else {
      users.add(String(userId));
      saveDebugUsers(users);
      return mcpOk("Debug mode ON — intermediate thinking/tool details will be shown.");
    }
  },
);

await connectStdio(server);
