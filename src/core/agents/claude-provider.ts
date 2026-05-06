import type {
  Options,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { extractFileEvents } from "@/core/agents/file-events";
import { CLAUDE_EXECUTABLE, getCleanEnv } from "@/core/config";
import { logger } from "@/core/logger";
import { getMcpServersForQuery } from "@/core/mcp-config";
import type { AgentQueryOptions, EffortLevel, UnifiedEvent } from "@/core/types";
import { CLAUDE_EFFORT_VALUES } from "@/core/types";

type ClaudeEffort = Exclude<EffortLevel, "minimal">;
function toClaudeEffort(e: EffortLevel | undefined): ClaudeEffort | undefined {
  if (!e || !CLAUDE_EFFORT_VALUES.includes(e as typeof CLAUDE_EFFORT_VALUES[number])) return undefined;
  return e as ClaudeEffort;
}

interface ContentBlockStart {
  type: "content_block_start";
  content_block: { type: string; name?: string };
}
interface ContentBlockDelta {
  type: "content_block_delta";
  delta: { type: string; partial_json?: string; text?: string };
}
interface ContentBlockStop { type: "content_block_stop" }
type StreamEvent = ContentBlockStart | ContentBlockDelta | ContentBlockStop | { type: string };

interface TextBlock { type: "text"; text: string }
interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string | unknown }
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string };

export async function* claudeProvider(opts: AgentQueryOptions): AsyncGenerator<UnifiedEvent> {
  const queryOptions: Options = {
    pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    env: getCleanEnv(),
    mcpServers: getMcpServersForQuery(opts) as Options["mcpServers"],
    abortController: opts.abortController,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.agents
      ? {
          agents: Object.fromEntries(
            Object.entries(opts.agents).map(([name, def]) => {
              const { effort, ...rest } = def;
              const narrowed = typeof effort === "string" ? toClaudeEffort(effort as EffortLevel) : effort;
              return [name, narrowed !== undefined ? { ...rest, effort: narrowed } : rest];
            }),
          ) as Options["agents"],
        }
      : {}),
    ...(toClaudeEffort(opts.effort) ? { effort: toClaudeEffort(opts.effort) as Options["effort"] } : {}),
    settingSources: ["project"] as Options["settingSources"],
    systemPrompt: opts.systemPrompt,
  };

  if (opts.sessionId) queryOptions.resume = opts.sessionId;

  let pendingToolName: string | null = null;
  let pendingToolInput = "";

  for await (const message of query({ prompt: opts.prompt, options: queryOptions })) {
    if (message.type === "stream_event") {
      const streamMsg = message as SDKPartialAssistantMessage;
      const evt = (streamMsg as { event?: StreamEvent }).event;
      if (!evt) continue;

      if (evt.type === "content_block_start") {
        const start = evt as ContentBlockStart;
        if (start.content_block.type === "tool_use" && start.content_block.name) {
          pendingToolName = start.content_block.name;
          pendingToolInput = "";
        }
      }

      if (evt.type === "content_block_delta") {
        const delta = evt as ContentBlockDelta;
        if (delta.delta.type === "input_json_delta" && delta.delta.partial_json) {
          pendingToolInput += delta.delta.partial_json;
        }
        if (delta.delta.type === "text_delta" && delta.delta.text) {
          yield { type: "text_delta", content: delta.delta.text };
        }
      }

      if (evt.type === "content_block_stop" && pendingToolName) {
        let parsedInput: Record<string, unknown> = {};
        let parseFailed = false;
        try {
          if (pendingToolInput) parsedInput = JSON.parse(pendingToolInput);
        } catch (e) {
          logger.error({ err: e, toolName: pendingToolName, raw: pendingToolInput.slice(0, 200) }, "Failed to parse tool input — skipping tool_use event");
          parseFailed = true;
        }
        if (!parseFailed) yield { type: "tool_use", name: pendingToolName, input: parsedInput };
        pendingToolName = null;
        pendingToolInput = "";
      }
      continue;
    }

    if (message.type === "tool_progress") {
      const m = message as SDKToolProgressMessage;
      yield { type: "tool_progress", toolName: m.tool_name, elapsed: m.elapsed_time_seconds };
      continue;
    }

    if (message.type === "tool_use_summary") {
      const m = message as SDKToolUseSummaryMessage;
      yield { type: "tool_use_summary", summary: m.summary };
      continue;
    }

    if (message.type === "system") {
      const m = message as SDKSystemMessage;
      if (m.subtype === "init") yield { type: "session", sessionId: m.session_id };
      continue;
    }

    if (message.type === "result") {
      const m = message as SDKResultMessage;
      if (m.subtype === "success") {
        yield {
          type: "result",
          content: m.result,
          stopReason: m.stop_reason ?? "end_turn",
          usage: m.usage
            ? {
                inputTokens: m.usage.input_tokens,
                outputTokens: m.usage.output_tokens,
                cacheCreationInputTokens: m.usage.cache_creation_input_tokens ?? undefined,
                cacheReadInputTokens: m.usage.cache_read_input_tokens ?? undefined,
              }
            : undefined,
        };
        yield* extractFileEvents(m.result, "result");
      } else {
        yield { type: "error", content: m.errors?.join("; ") || "Unknown error" };
      }
      continue;
    }

    if (message.type === "assistant") {
      const m = message as SDKAssistantMessage;
      const content = (m.message?.content ?? []) as ContentBlock[];
      for (const block of content) {
        if (block.type === "text") {
          const tb = block as TextBlock;
          yield { type: "text", content: tb.text };
          yield* extractFileEvents(tb.text, "text");
        } else if (block.type === "tool_result") {
          const trBlock = block as ToolResultBlock;
          yield {
            type: "tool_result",
            toolUseId: trBlock.tool_use_id || "",
            content: typeof trBlock.content === "string" ? trBlock.content.slice(0, 200) : "",
          };
        } else if (block.type === "tool_use") {
          const tb = block as ToolUseBlock;
          yield { type: "tool_use", name: tb.name, input: tb.input || {} };
          // Direct file path extraction from send_file tools
          if (tb.input && (tb.name === "send_file" || tb.name === "send_files")) {
            const fp = (tb.input.file_path as string) || (tb.input.path as string) || (tb.input.filename as string);
            if (fp) yield { type: "file", path: fp, source: tb.name };
            const fps = tb.input.file_paths as string[] | undefined;
            if (Array.isArray(fps)) {
              for (const p of fps) if (typeof p === "string") yield { type: "file", path: p, source: tb.name };
            }
          }
        }
      }
    }
  }
}
