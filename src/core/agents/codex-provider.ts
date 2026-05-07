import type { ModelReasoningEffort, SandboxMode, ThreadOptions } from "@openai/codex-sdk";
import { Codex } from "@openai/codex-sdk";
import { errMsg } from "@/core/error";
import { logger } from "@/core/logger";
import { getMcpServersForQuery } from "@/core/mcp-config";
import type { AgentQueryOptions, EffortLevel, UnifiedEvent } from "@/core/types";

function mapEffort(effort?: EffortLevel): ModelReasoningEffort | undefined {
  if (!effort) return undefined;
  if (effort === "max") {
    throw new Error("codexProvider received effort='max' — codex does not support it");
  }
  return effort as ModelReasoningEffort;
}

function toCodexMcpServers(
  claudeShape: Record<string, unknown>,
): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
  // Codex SDK may not inherit process.env when spawning MCP subprocesses.
  // Explicitly forward env so critical vars like SERVER_NAME reach the servers.
  const parentEnv = process.env as Record<string, string>;
  const out: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
  for (const [name, srv] of Object.entries(claudeShape)) {
    if (!srv || typeof srv !== "object") continue;
    const s = srv as Record<string, unknown>;
    if (typeof s.command !== "string") continue;
    const configEnv = (s.env && typeof s.env === "object") ? s.env as Record<string, string> : {};
    out[name] = {
      command: s.command,
      ...(Array.isArray(s.args) ? { args: s.args as string[] } : {}),
      env: { ...parentEnv, ...configEnv },
    };
  }
  return out;
}

function isMissingRolloutError(err: unknown): boolean {
  return /no rollout found|thread\/resume failed/i.test(errMsg(err));
}

function promptForThread(opts: AgentQueryOptions, includeSystemPrompt: boolean): string {
  return includeSystemPrompt && opts.systemPrompt
    ? `[System Instructions]\n${opts.systemPrompt}\n\n${opts.prompt}`
    : opts.prompt;
}

export async function* codexProvider(opts: AgentQueryOptions): AsyncGenerator<UnifiedEvent> {
  const codex = new Codex({
    config: { mcp_servers: toCodexMcpServers(getMcpServersForQuery(opts)) },
  });

  const threadOptions: ThreadOptions = {
    workingDirectory: opts.cwd,
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access" as SandboxMode,
    approvalPolicy: "never",
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { modelReasoningEffort: mapEffort(opts.effort) } : {}),
  };

  let thread = opts.sessionId
    ? codex.resumeThread(opts.sessionId, threadOptions)
    : codex.startThread(threadOptions);

  let prompt = promptForThread(opts, !opts.sessionId);
  let agentTextSoFar = "";
  let finalText = "";
  const stopReason = "end_turn";

  let runResult: Awaited<ReturnType<typeof thread.runStreamed>>;
  try {
    runResult = await thread.runStreamed(prompt, {
      ...(opts.abortController ? { signal: opts.abortController.signal } : {}),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    if (!opts.sessionId || !isMissingRolloutError(err)) throw err;

    logger.warn({ staleSessionId: opts.sessionId, err: errMsg(err) }, "codexProvider: stale rollout, restarting fresh thread");
    thread = codex.startThread(threadOptions);
    prompt = promptForThread(opts, true);
    try {
      runResult = await thread.runStreamed(prompt, {
        ...(opts.abortController ? { signal: opts.abortController.signal } : {}),
      });
    } catch (retryErr) {
      if (retryErr instanceof Error && retryErr.name === "AbortError") return;
      throw retryErr;
    }
  }

  try {
    for await (const event of runResult.events) {
      switch (event.type) {
        case "thread.started": {
          yield { type: "session", sessionId: (event as { thread_id: string }).thread_id };
          break;
        }
        case "item.started": {
          const item = (event as { item: Record<string, unknown> }).item;
          if (item.type === "command_execution") {
            yield { type: "tool_use", name: "Bash", input: { command: String(item.command ?? "") } };
          } else if (item.type === "mcp_tool_call") {
            yield { type: "tool_use", name: String(item.tool ?? "unknown"), input: (item.arguments as Record<string, unknown>) || {} };
          }
          break;
        }
        case "item.updated": {
          const item = (event as { item: Record<string, unknown> }).item;
          if (item.type === "agent_message") {
            const text = String(item.text ?? "");
            const newChars = text.slice(agentTextSoFar.length);
            if (newChars) { yield { type: "text_delta", content: newChars }; agentTextSoFar = text; }
          }
          break;
        }
        case "item.completed": {
          const item = (event as { item: Record<string, unknown> }).item;
          if (item.type === "agent_message") {
            finalText = String(item.text ?? "");
            agentTextSoFar = finalText;
            yield { type: "text", content: finalText };
          } else if (item.type === "mcp_tool_call") {
            const result = item.result;
            yield {
              type: "tool_result",
              toolUseId: String(item.id ?? ""),
              content: (typeof result === "string" ? result : JSON.stringify(result ?? "")).slice(0, 200),
            };
          } else if (item.type === "command_execution") {
            yield {
              type: "tool_result",
              toolUseId: String(item.id ?? ""),
              content: String(item.aggregated_output ?? item.stdout ?? "").slice(0, 200),
            };
          } else if (item.type === "error") {
            yield { type: "error", content: String(item.message ?? "Codex error") };
          }
          break;
        }
        case "turn.completed": {
          const usage = (event as { usage?: Record<string, number> }).usage;
          yield {
            type: "result",
            content: finalText,
            stopReason,
            ...(usage
              ? {
                  usage: {
                    inputTokens: Number(usage.input_tokens ?? 0),
                    outputTokens: Number(usage.output_tokens ?? 0),
                    cacheReadInputTokens: usage.cached_input_tokens != null ? Number(usage.cached_input_tokens) : undefined,
                  },
                }
              : {}),
          };
          break;
        }
        case "turn.failed": {
          const errPayload = (event as { error?: { message?: string } }).error;
          yield { type: "error", content: errPayload?.message || "Codex turn failed" };
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    logger.error({ err }, "codexProvider: stream iteration failed");
    yield { type: "error", content: errMsg(err) };
  }
}
