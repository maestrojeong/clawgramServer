import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRegistry } from "@/core/agents/registry";
import { writeCodexRollout } from "@/core/agents/rollout/codex";
import { logger } from "@/core/logger";
import { readConversation } from "@/core/storage/conversations";
import { CODEX_EFFORT_VALUES, type EffortLevel } from "@/core/types";

const VALID_EFFORTS = new Set<EffortLevel>(CODEX_EFFORT_VALUES);

export const codexRegistry: AgentRegistry = {
  kind: "codex",
  defaultModel: "gpt-5.5",

  expandModelAlias(s) { return s; },
  validateModel(s) { return typeof s === "string" && s.length > 0; },

  validEfforts: CODEX_EFFORT_VALUES,
  validateEffort(s) { return VALID_EFFORTS.has(s); },

  footerLabel(model, effort) { return `${model} · ${effort ?? "(off)"}`; },

  writeRollout(opts) {
    const { threadId, rolloutPath } = writeCodexRollout({
      cwd: opts.cwd,
      entries: opts.entries,
      ...(opts.reuseSessionId ? { threadId: opts.reuseSessionId } : {}),
    });
    return { sessionId: threadId, rolloutPath };
  },

  async forkSession({ cwd, userId, topicName, groupId }) {
    const entries = readConversation(userId, topicName, groupId);
    const { threadId, rolloutPath } = writeCodexRollout({ cwd, entries });
    return { forkId: threadId, rolloutPath };
  },

  async cleanupRollouts({ sessionIds }) {
    if (sessionIds.length === 0) return;
    const sessionsDir = join(homedir(), ".codex", "sessions");
    const failures: unknown[] = [];
    for (const tid of sessionIds) {
      try {
        const glob = new Bun.Glob(`**/rollout-*-${tid}.jsonl`);
        for await (const rel of glob.scan({ cwd: sessionsDir, onlyFiles: true })) {
          const path = join(sessionsDir, rel);
          try { unlinkSync(path); }
          catch (e) {
            if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
              logger.warn({ err: e, path }, "codex cleanupRollouts: unlink failed");
              failures.push(e);
            }
          }
        }
      } catch (e) {
        logger.warn({ err: e, threadId: tid }, "codex cleanupRollouts: scan failed");
        failures.push(e);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "codex cleanupRollouts failed");
  },
};
