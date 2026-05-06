import { claudeProvider } from "@/core/agents/claude-provider";
import { codexProvider } from "@/core/agents/codex-provider";
import { appendConversationEvent } from "@/core/storage/conversations";
import type { AgentKind, AgentQueryOptions, UnifiedEvent } from "@/core/types";

async function* dispatchAgent(opts: AgentQueryOptions): AsyncGenerator<UnifiedEvent> {
  const agent = opts.agent ?? FALLBACK_AGENT;
  switch (agent) {
    case "claude": yield* claudeProvider({ ...opts, agent: "claude" }); return;
    case "codex":  yield* codexProvider({ ...opts, agent: "codex" }); return;
    default: {
      const exhaustive: never = agent;
      throw new Error(`runAgent: unknown agent '${exhaustive}'`);
    }
  }
}

function shouldRecordTurn(
  opts: AgentQueryOptions,
): opts is AgentQueryOptions & { userId: string; session: string } {
  return (
    !opts.silent &&
    typeof opts.userId === "string" && opts.userId.length > 0 &&
    typeof opts.session === "string" && opts.session.length > 0
  );
}

export async function* runAgent(opts: AgentQueryOptions): AsyncGenerator<UnifiedEvent> {
  const recording = shouldRecordTurn(opts);
  const agent = opts.agent ?? FALLBACK_AGENT;
  for await (const event of dispatchAgent(opts)) {
    if (recording) {
      appendConversationEvent(opts.userId, opts.session, agent, event, opts.groupId);
    }
    yield event;
  }
}

export const SUPPORTED_AGENTS: readonly AgentKind[] = ["claude", "codex"] as const;
export const FALLBACK_AGENT: AgentKind = "claude";

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (SUPPORTED_AGENTS as readonly string[]).includes(value);
}
