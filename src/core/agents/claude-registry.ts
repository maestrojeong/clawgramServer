import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRegistry } from "@/core/agents/registry";
import { encodeClaudeCwd, writeClaudeRollout } from "@/core/agents/rollout/claude";
import { MODEL_HAIKU, MODEL_OPUS, MODEL_SONNET } from "@/core/config";
import { logger } from "@/core/logger";
import { CLAUDE_EFFORT_VALUES, type EffortLevel } from "@/core/types";

const ALIAS_MAP: Record<string, string> = {
  sonnet: MODEL_SONNET,
  opus: MODEL_OPUS,
  haiku: MODEL_HAIKU,
};
const VALID_ALIASES = new Set(Object.keys(ALIAS_MAP));
const VALID_FULL_IDS = new Set(Object.values(ALIAS_MAP));
const VALID_EFFORTS = new Set<EffortLevel>(CLAUDE_EFFORT_VALUES);

export const claudeRegistry: AgentRegistry = {
  kind: "claude",
  defaultModel: "sonnet",
  defaultEffort: "high",

  expandModelAlias(s) { return ALIAS_MAP[s] ?? s; },
  validateModel(s) { return VALID_ALIASES.has(s) || VALID_FULL_IDS.has(s); },

  validEfforts: CLAUDE_EFFORT_VALUES,
  validateEffort(s) { return VALID_EFFORTS.has(s); },

  footerLabel(model, effort) { return effort ? `${model} · ${effort}` : model; },

  writeRollout(opts) {
    const { sessionId, rolloutPath } = writeClaudeRollout({
      cwd: opts.cwd,
      entries: opts.entries,
      ...(opts.reuseSessionId ? { sessionId: opts.reuseSessionId } : {}),
    });
    return { sessionId, rolloutPath };
  },

  async forkSession({ parentSessionId, cwd, title }) {
    const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");
    const result = await forkSession(parentSessionId, { dir: cwd, ...(title ? { title } : {}) });
    return {
      forkId: result.sessionId,
      rolloutPath: join(cwd, ".claude", "sessions", `${result.sessionId}.jsonl`),
    };
  },

  async cleanupRollouts({ cwd, sessionIds }) {
    const projectsDir = join(homedir(), ".claude", "projects", encodeClaudeCwd(cwd));
    const failures: unknown[] = [];
    for (const sid of sessionIds) {
      const path = join(projectsDir, `${sid}.jsonl`);
      try { unlinkSync(path); }
      catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
          logger.warn({ err: e, path }, "claude cleanupRollouts: unlink failed");
          failures.push(e);
        }
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "claude cleanupRollouts failed");
  },
};
