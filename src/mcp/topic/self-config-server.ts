#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRegistry } from "@/core/agents/registry";
import { SUPPORTED_AGENTS } from "@/core/agents";
import { EFFORT_VALUES, type AgentKind, type EffortLevel } from "@/core/types";
import {
  getTopicAgent,
  getTopicByName,
  setTopicAgent,
  setTopicEffort,
  setTopicModel,
} from "@/telegram/forum-sessions";
import { connectStdio, mcpError, mcpOk, parseGroupIdArg, parseUserIdArg } from "@/mcp/mcp-helpers";

const args = process.argv.slice(2);
const userIdStr = parseUserIdArg(args);
const userId = Number(userIdStr);
const groupId = parseGroupIdArg(args);
const currentTopic = args.find((a) => a.startsWith("--topic="))?.split("=")[1] || "";

const server = new McpServer({ name: "topic-self-config", version: "1.0.0" });

const AGENT_VALUES = SUPPORTED_AGENTS as readonly AgentKind[];

function hasContext(): boolean {
  return Number.isFinite(userId) && userId > 0 && currentTopic.length > 0;
}

type RequireTopicResult =
  | { ok: true; topic: NonNullable<ReturnType<typeof getTopicByName>> }
  | { ok: false; response: ReturnType<typeof mcpError> };

function requireTopic(): RequireTopicResult {
  if (!hasContext()) return { ok: false, response: mcpError("Error: missing userId/topic context.") };
  const topic = getTopicByName(currentTopic);
  if (!topic) return { ok: false, response: mcpError(`Error: topic "${currentTopic}" not found.`) };
  return { ok: true, topic };
}

server.tool(
  "set_effort",
  "Set the effort (reasoning depth) for THIS topic. Persists across queries and applies starting from the NEXT user message. Valid values depend on the topic's agent: Claude topics accept low/medium/high/xhigh/max; Codex topics accept minimal/low/medium/high/xhigh. Only call when a clear benefit is expected — effort changes are visible to the user and affect cost.",
  {
    level: z
      .enum(EFFORT_VALUES)
      .describe("Effort level. Claude: low, medium, high, xhigh, max. Codex: minimal, low, medium, high, xhigh."),
  },
  async ({ level }) => {
    const r = requireTopic();
    if (!r.ok) return r.response;
    const registry = getRegistry(r.topic.agent);
    if (!registry.validateEffort(level as EffortLevel)) {
      return mcpError(
        `Effort '${level}' is not valid for agent '${r.topic.agent}'. Valid: ${registry.validEfforts.join(", ")}.`,
      );
    }
    const changed = setTopicEffort(currentTopic, level as EffortLevel);
    if (!changed) return mcpError(`Error: failed to set effort for "${currentTopic}".`);
    return mcpOk(`Effort for "${currentTopic}" set to ${level}. Applies from the next message.`);
  },
);

server.tool(
  "get_effort",
  "Get the current effort (reasoning depth) setting for THIS topic.",
  {},
  async () => {
    const r = requireTopic();
    if (!r.ok) return r.response;
    const registry = getRegistry(r.topic.agent);
    const fallback = registry.defaultEffort
      ? `default (${registry.defaultEffort})`
      : "default (none — reasoning off)";
    const value = r.topic.effort ?? fallback;
    return mcpOk(`Effort for "${currentTopic}" (agent=${r.topic.agent}): ${value}`);
  },
);

server.tool(
  "set_model",
  "Set the model for THIS topic. Persists across queries and applies from the NEXT message. Claude topics: 'sonnet' / 'opus' / 'haiku'. Codex topics: an OpenAI model id ('gpt-5.5', 'gpt-5', 'o3', ...). The model name must match the topic's current agent — switch agent first via set_agent if needed.",
  {
    model: z
      .string()
      .describe("Model id. Claude: 'sonnet' / 'opus' / 'haiku'. Codex: any OpenAI model id (e.g. 'gpt-5.5')."),
  },
  async ({ model }) => {
    const r = requireTopic();
    if (!r.ok) return r.response;
    const registry = getRegistry(r.topic.agent);
    if (!registry.validateModel(model)) {
      return mcpError(
        `Error: model '${model}' is not valid for agent '${r.topic.agent}' on topic "${currentTopic}".`,
      );
    }
    const changed = setTopicModel(currentTopic, model);
    if (!changed) return mcpError(`Error: failed to set model for "${currentTopic}".`);
    return mcpOk(`Model for "${currentTopic}" set to ${model}. Applies from the next message.`);
  },
);

server.tool(
  "get_model",
  "Get the current model setting for THIS topic.",
  {},
  async () => {
    const r = requireTopic();
    if (!r.ok) return r.response;
    const registry = getRegistry(r.topic.agent);
    const value = r.topic.model ?? `default (${registry.defaultModel})`;
    return mcpOk(`Model for "${currentTopic}" (agent=${r.topic.agent}): ${value}`);
  },
);

server.tool(
  "set_agent",
  "Switch the agent backend for THIS topic between 'claude' (Claude Code SDK / Anthropic) and 'codex' (Codex SDK / OpenAI). The session is reset so the new backend starts fresh. Use only when the user explicitly asks to switch agents.",
  {
    agent: z
      .enum(AGENT_VALUES as unknown as [AgentKind, ...AgentKind[]])
      .describe("Agent backend: 'claude' or 'codex'"),
  },
  async ({ agent }) => {
    if (!hasContext()) return mcpError("Error: missing userId/topic context.");
    const current = getTopicAgent(currentTopic);
    if (current === agent) {
      return mcpOk(`Agent for "${currentTopic}" is already '${agent}'.`);
    }
    const changed = setTopicAgent(currentTopic, agent);
    if (!changed) return mcpError(`Error: failed to switch agent for "${currentTopic}".`);
    return mcpOk(
      `Agent for "${currentTopic}" switched to '${agent}'. Session reset — next message starts a fresh conversation.`,
    );
  },
);

server.tool(
  "get_agent",
  "Get the current agent backend ('claude' or 'codex') for THIS topic.",
  {},
  async () => {
    if (!hasContext()) return mcpError("Error: missing userId/topic context.");
    const agent = getTopicAgent(currentTopic);
    return mcpOk(`Agent for "${currentTopic}": ${agent}`);
  },
);

// Suppress unused-var warning for groupId (kept for future multi-group scoping)
void groupId;

await connectStdio(server);
