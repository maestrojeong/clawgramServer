import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeEvent, ClaudeQueryOptions } from "@/core/types";
import { SYSTEM_PROMPT } from "@/core/config";
import { logger } from "@/core/logger";
import {
  CLAUDE_EXECUTABLE,
  FILE_TAG_REGEX,
  FILE_EXTENSIONS_REGEX,
} from "@/core/config";
import { getDmMcpServers, getForumMcpServers } from "@/core/mcp-config";

// --- Stream event sub-types (from @anthropic-ai/sdk, not directly importable) ---
interface ContentBlockStart {
  type: "content_block_start";
  content_block: { type: string; name?: string };
}
interface ContentBlockDelta {
  type: "content_block_delta";
  delta: { type: string; partial_json?: string; text?: string };
}
interface ContentBlockStop {
  type: "content_block_stop";
}
type StreamEvent = ContentBlockStart | ContentBlockDelta | ContentBlockStop | { type: string };

// --- Assistant message content block types (from BetaMessage.content) ---
interface TextBlock {
  type: "text";
  text: string;
}
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown;
}
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string };

/**
 * Core Claude query function.
 * Yields normalized ClaudeEvent objects that any client (web, telegram, etc.) can consume.
 */
export async function* claudeQuery(
  opts: ClaudeQueryOptions
): AsyncGenerator<ClaudeEvent> {
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;

  const queryOptions: Options = {
    pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
    cwd: opts.cwd || process.cwd(),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    env: cleanEnv,
    mcpServers: (opts.sessionType === 'dm' || opts.sessionType === 'ephemeral'
      ? getDmMcpServers({ userId: opts.userId || "default" })
      : getForumMcpServers({
          userId: opts.userId || "default",
          session: opts.session || "default",
          depth: opts.depth,
          silent: opts.silent,
          enabled: opts.mcpEnabled,
          extra: opts.mcpExtra,
        })
    ) as Options["mcpServers"],
    abortController: opts.abortController,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.agents ? { agents: opts.agents as Options["agents"] } : {}),
    ...(opts.effort ? { effort: opts.effort as Options["effort"] } : {}),
    settingSources: ["project"] as Options["settingSources"],
    systemPrompt: opts.systemPrompt ?? SYSTEM_PROMPT,
  };

  if (opts.sessionId) {
    queryOptions.resume = opts.sessionId;
  }

  let pendingToolName: string | null = null;
  let pendingToolInput = "";

  for await (const message of query({
    prompt: opts.prompt,
    options: queryOptions,
  })) {
    // --- Stream events (token-by-token) ---
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
        if (!parseFailed) {
          yield { type: "tool_use", name: pendingToolName, input: parsedInput };
        }
        pendingToolName = null;
        pendingToolInput = "";
      }

      continue;
    }

    // --- Tool progress ---
    if (message.type === "tool_progress") {
      const m = message as SDKToolProgressMessage;
      yield {
        type: "tool_progress",
        toolName: m.tool_name,
        elapsed: m.elapsed_time_seconds,
      };
      continue;
    }

    // --- Tool use summary ---
    if (message.type === "tool_use_summary") {
      const m = message as SDKToolUseSummaryMessage;
      yield { type: "tool_use_summary", summary: m.summary };
      continue;
    }

    // --- System init ---
    if (message.type === "system") {
      const m = message as SDKSystemMessage;
      if (m.subtype === "init") {
        yield { type: "session", sessionId: m.session_id };
      }
      continue;
    }

    // --- Result ---
    if (message.type === "result") {
      const m = message as SDKResultMessage;
      if (m.subtype === "success") {
        yield {
          type: "result",
          content: m.result,
          stopReason: m.stop_reason ?? "end_turn",
          usage: m.usage ? {
            inputTokens: m.usage.input_tokens,
            outputTokens: m.usage.output_tokens,
            cacheCreationInputTokens: m.usage.cache_creation_input_tokens ?? undefined,
            cacheReadInputTokens: m.usage.cache_read_input_tokens ?? undefined,
          } : undefined,
        };
        yield* extractFiles(m.result, "result");
      } else {
        // Error result
        const errorMsg = m.errors?.join("; ") || "Unknown error";
        yield { type: "error", content: errorMsg };
      }
      continue;
    }

    // --- Assistant message ---
    if (message.type === "assistant") {
      const m = message as SDKAssistantMessage;
      const content = (m.message?.content ?? []) as ContentBlock[];

      for (const block of content) {
        if (block.type === "text") {
          const textBlock = block as TextBlock;
          yield { type: "text", content: textBlock.text };
          yield* extractFiles(textBlock.text, "text");
        } else if (block.type === "tool_result") {
          const trBlock = block as ToolResultBlock;
          const trContent = typeof trBlock.content === "string"
            ? trBlock.content.slice(0, 200)
            : "";
          yield {
            type: "tool_result",
            toolUseId: trBlock.tool_use_id || "",
            content: trContent,
          };
        } else if (block.type === "tool_use") {
          const tb = block as ToolUseBlock;
          yield {
            type: "tool_use",
            name: tb.name,
            input: tb.input || {},
          };
          // Extract file paths only from MCP send tools
          if (tb.input && (tb.name === "send_file" || tb.name === "send_files")) {
            const filePath =
              (tb.input.file_path as string) ||
              (tb.input.path as string) ||
              (tb.input.filename as string);
            if (filePath && typeof filePath === "string") {
              yield { type: "file", path: filePath, source: tb.name };
            }
            const filePaths = tb.input.file_paths as string[] | undefined;
            if (Array.isArray(filePaths)) {
              for (const fp of filePaths) {
                if (typeof fp === "string") {
                  yield { type: "file", path: fp, source: tb.name };
                }
              }
            }
          }
        }
      }
      continue;
    }
  }
}

/** Extract file paths from text using [FILE:...] tags and bare path regex */
function* extractFiles(
  text: string,
  source: string
): Generator<ClaudeEvent> {
  // [FILE:...] tags
  const tagRegex = new RegExp(FILE_TAG_REGEX.source, "gi");
  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    yield { type: "file", path: match[1], source };
  }

  // Bare file paths
  const pathRegex = new RegExp(FILE_EXTENSIONS_REGEX.source, "gi");
  const pathMatches = text.match(pathRegex);
  if (pathMatches) {
    for (const m of [...new Set(pathMatches)]) {
      yield { type: "file", path: m, source };
    }
  }
}

/** Format a tool_use event into a human-readable string */
export function formatToolUse(
  name: string,
  input: Record<string, unknown>
): string {
  let detail = "";
  if (input.command) detail = String(input.command);
  else if (input.file_path || input.path)
    detail = String(input.file_path || input.path);
  else if (input.url) detail = String(input.url);
  else if (input.pattern) detail = String(input.pattern);
  else if (input.query || input.text)
    detail = String(input.query || input.text);
  else if (input.task) detail = String(input.task);
  else if (input.to) detail = String(input.to);
  else if (input.message) detail = String(input.message).slice(0, 80);
  else if (input.content) detail = String(input.content).slice(0, 80);

  if (detail) {
    return `${name}(${detail.length > 100 ? detail.slice(0, 100) + "..." : detail})`;
  }
  return name;
}
