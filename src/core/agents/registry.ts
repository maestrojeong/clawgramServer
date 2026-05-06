import { claudeRegistry } from "@/core/agents/claude-registry";
import { codexRegistry } from "@/core/agents/codex-registry";
import type { ConversationEntry } from "@/core/storage/conversations";
import type { AgentKind, EffortLevel } from "@/core/types";

export interface WriteRolloutOptions {
  cwd: string;
  entries: ConversationEntry[];
  reuseSessionId?: string;
}

export interface WriteRolloutResult {
  sessionId: string;
  rolloutPath: string;
}

export interface ForkRegistryOptions {
  parentSessionId: string;
  cwd: string;
  userId: number | string;
  topicName: string;
  groupId?: number;
  title?: string;
}

export interface ForkRegistryResult {
  forkId: string;
  rolloutPath: string;
}

export interface CleanupRolloutsOptions {
  cwd: string;
  sessionIds: string[];
}

export interface AgentRegistry {
  kind: AgentKind;
  defaultModel: string;
  defaultEffort?: EffortLevel;
  expandModelAlias(s: string): string;
  validateModel(s: string): boolean;
  validEfforts: readonly EffortLevel[];
  validateEffort(s: EffortLevel): boolean;
  footerLabel(model: string, effort?: EffortLevel): string;
  writeRollout(opts: WriteRolloutOptions): WriteRolloutResult;
  forkSession(opts: ForkRegistryOptions): Promise<ForkRegistryResult>;
  cleanupRollouts(opts: CleanupRolloutsOptions): Promise<void>;
}

const REGISTRIES: Record<AgentKind, AgentRegistry> = {
  claude: claudeRegistry,
  codex: codexRegistry,
};

export function getRegistry(agent: AgentKind): AgentRegistry {
  return REGISTRIES[agent];
}
