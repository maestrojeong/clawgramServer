#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, appendFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

import { ACTIVE_QUERY_STALE_MS, USERS_LOG_DIR, HTML_PAGE_SERVER, SERVER_NAME } from "@/core/config";
import { ALL_FORUM_MCP_SERVER_NAMES, REQUIRED_FORUM_MCP_SERVERS } from "@/core/mcp-config";
import { createContextId } from "@/core/context-store";

import type { QueryState } from "./session-comm-utils";
import {
  SESSION_INBOX_DIR,
  userId,
  currentTopic,
  currentDepth,
  isReplyOnly,
  MAX_TELL_DEPTH,
  MAX_MESSAGE_LENGTH,
  getTopicCwd,
  getTopicsForUser,
  writeProgress,
  clearProgress,
  cleanupFork,
  queryForkSession,
  formatForkResult,
  getMcpConfig,
  setMcpConfig,
  setCurrentTopicDescription,
} from "./session-comm-utils";

// --- MCP Server ---

const server = new McpServer({
  name: "session-comm",
  version: "1.0.0",
});

// --- always available ---

server.tool(
  "list_sessions",
  "List all available Claude sessions (forum topics) for inter-session communication.",
  {},
  async () => {
    const topics = getTopicsForUser();
    const entries = Object.entries(topics)
      .filter(([name]) => name !== currentTopic)
      .map(([name, t]) => {
        const status = t.sessionId ? `active (${t.sessionId.slice(0, 8)})` : "no session";
        const cron = t.cronSessionId ? ` | cron: active` : "";
        const desc = t.description ? `\n    description: ${t.description.slice(0, 80)}${t.description.length > 80 ? "..." : ""}` : "";
        return `- ${name}: ${status}${cron}${desc}`;
      });

    // Fetch remote sessions from Hub
    if (HTML_PAGE_SERVER) {
      try {
        const res = await fetch(`${HTML_PAGE_SERVER}/relay/sessions`);
        if (res.ok) {
          const remote = await res.json() as Record<string, string[]>;
          for (const [serverId, topics] of Object.entries(remote)) {
            if (serverId === SERVER_NAME) continue; // skip self
            for (const topic of topics) {
              entries.push(`- @${serverId}/${topic}: remote server`);
            }
          }
        }
      } catch { /* Hub unreachable, ignore */ }
    }

    if (entries.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No other sessions available." }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Current session: ${currentTopic}\nTell depth: ${currentDepth}/${MAX_TELL_DEPTH}\n\nAvailable sessions:\n${entries.join("\n")}`,
        },
      ],
    };
  }
);

server.tool(
  "configure_mcp",
  `Configure MCP servers for the current topic. Changes take effect on the next session start.\n` +
  `Available default servers: ${ALL_FORUM_MCP_SERVER_NAMES.join(", ")}\n` +
  `- enabled: whitelist of servers to load (null = restore all defaults). Required servers always included: ${REQUIRED_FORUM_MCP_SERVERS.join(", ")}\n` +
  `- extra: custom server configs to add on top (key = server name, value = { command, args } or { type: "sse", url })`,
  {
    enabled: z.array(z.string()).nullable().optional().describe(
      `Servers to enable. null = all defaults, [] = none, or list specific names e.g. ["session-comm","cron-manager","send-file"]`
    ),
    extra: z.record(z.string(), z.any()).optional().describe(
      `Custom MCP server configs to add (e.g. { "slack": { command: "bun", args: ["run", "/path/to/server.ts"] } })`
    ),
  },
  async ({ enabled, extra }) => {
    if (!currentTopic || !userId) {
      return { content: [{ type: "text" as const, text: "Error: No current topic." }], isError: true };
    }
    if (enabled !== null && enabled !== undefined) {
      const missing = (REQUIRED_FORUM_MCP_SERVERS as readonly string[]).filter(r => !enabled.includes(r));
      if (missing.length > 0) {
        return { content: [{ type: "text" as const, text: `Error: 필수 서버는 비활성화할 수 없음: ${missing.join(", ")}` }], isError: true };
      }
    }
    try {
      setMcpConfig(enabled, extra as Record<string, unknown> | undefined);
      const current = getMcpConfig();
      const active = current.enabled !== null
        ? current.enabled
        : [...ALL_FORUM_MCP_SERVER_NAMES];
      const lines = [
        `MCP 설정 저장됨 (다음 세션부터 적용)`,
        ``,
        `활성 서버: ${active.length > 0 ? active.join(", ") : "없음"}`,
        `추가 서버: ${Object.keys(current.extra).length > 0 ? Object.keys(current.extra).join(", ") : "없음"}`,
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "get_mcp_config",
  "Get the current MCP server configuration for this topic.",
  {},
  async () => {
    const config = getMcpConfig();
    const active = config.enabled !== null ? config.enabled : [...ALL_FORUM_MCP_SERVER_NAMES];
    const lines = [
      `현재 토픽: ${currentTopic}`,
      ``,
      `활성 서버: ${active.join(", ")}`,
      `설정 방식: ${config.enabled !== null ? "whitelist" : "기본값 (전체)"}`,
      `추가 서버: ${Object.keys(config.extra).length > 0 ? Object.keys(config.extra).join(", ") : "없음"}`,
      ``,
      `전체 기본 서버 목록: ${ALL_FORUM_MCP_SERVER_NAMES.join(", ")}`,
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.tool(
  "ask_cron",
  "Ask a question to this topic's cron session. The cron session has context from scheduled tasks (e.g. news scraping, monitoring). Use this when the user asks about data or results from cron jobs running in this topic.",
  {
    message: z.string().describe("Question or message to send to the cron session"),
  },
  async ({ message }) => {
    if (!currentTopic) {
      return {
        content: [{ type: "text" as const, text: "Error: No current topic detected." }],
        isError: true,
      };
    }

    const topics = getTopicsForUser();
    const self = topics[currentTopic];

    if (!self?.cronSessionId) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: No cron session found for topic "${currentTopic}". A cron job needs to run at least once to create a cron session.`,
        }],
        isError: true,
      };
    }

    const prompt = `[${currentTopic} 유저 세션에서 온 질문]\n${message}\n\n위 질문에 대해, 크론 작업에서 수집/처리한 데이터를 바탕으로 답변해주세요.`;

    let cronForkId: string | undefined;
    try {
      const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");
      const forkResult = await forkSession(self.cronSessionId, {
        dir: getTopicCwd(),
        title: `cron-query: ${currentTopic}`,
      });
      cronForkId = forkResult.sessionId;

      const queryResult = await queryForkSession(prompt, cronForkId, writeProgress);

      return {
        content: [{
          type: "text" as const,
          text: formatForkResult(`${currentTopic}:cron`, queryResult),
        }],
      };
    } catch (err) {
      const e = err as { message?: string };
      return {
        content: [{
          type: "text" as const,
          text: `Error communicating with cron session: ${e?.message || "Unknown error"}`,
        }],
        isError: true,
      };
    } finally {
      clearProgress();
      if (cronForkId) cleanupFork(cronForkId);
    }
  }
);

// --- always-available session inspection / self-config ---

server.tool(
  "peek_session",
  "Check which sessions are currently running a query (busy) vs idle. Useful before abort_session.",
  {},
  async () => {
    const topics = getTopicsForUser();
    const topicNames = Object.keys(topics);
    const activeQueriesDir = join(USERS_LOG_DIR, userId, "active-queries");

    // Read own query state for consistent display
    const selfStateFile = join(activeQueriesDir, `${currentTopic}.json`);
    let selfLabel = `${currentTopic} (자신 — 실행 중)`;
    try {
      const selfState = JSON.parse(readFileSync(selfStateFile, "utf-8")) as QueryState;
      const selfElapsed = Date.now() - new Date(selfState.since).getTime();
      const selfMins = Math.floor(selfElapsed / 60000);
      const selfSecs = Math.floor((selfElapsed % 60000) / 1000);
      const selfTimeStr = selfMins > 0 ? `${selfMins}분 ${selfSecs}초` : `${selfSecs}초`;
      const selfTaskStr = selfState.task ? ` | ${selfState.task}` : "";
      selfLabel = `${currentTopic} (자신 — ${selfTimeStr}${selfTaskStr})`;
    } catch { /* file absent or unreadable — fallback to default label */ }
    const running: string[] = [selfLabel];
    const idle: string[] = [];

    for (const name of topicNames) {
      if (name === currentTopic) continue;
      const stateFile = join(activeQueriesDir, `${name}.json`);
      let isRunning = false;
      if (existsSync(stateFile)) {
        try {
          const state = JSON.parse(readFileSync(stateFile, "utf-8")) as QueryState;
          const elapsed = Date.now() - new Date(state.since).getTime();
          if (elapsed <= ACTIVE_QUERY_STALE_MS) {
            const mins = Math.floor(elapsed / 60000);
            const secs = Math.floor((elapsed % 60000) / 1000);
            const timeStr = mins > 0 ? `${mins}분 ${secs}초` : `${secs}초`;
            const taskStr = state.task ? ` | ${state.task}` : "";
            running.push(`${name} (${timeStr}${taskStr})`);
            isRunning = true;
          }
        } catch { /* stale or corrupt, treat as idle */ }
      }
      if (!isRunning) idle.push(name);
    }

    const runningHeader = `실행 중 (${running.length}):\n${running.map(r => `  ${r}`).join("\n")}`;
    const lines = [
      `현재 세션 상태`,
      ``,
      runningHeader,
      `유휴 (${idle.length}): ${idle.join(", ") || "없음"}`,
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.tool(
  "set_description",
  "Set a description for the current session. Acts as a system prompt addition and routing hint for other sessions using list_sessions. Call this once at session start based on the topic's CLAUDE.md.",
  {
    description: z.string().describe("What this session specializes in (e.g. 'UE5 graphics development, shader optimization')"),
  },
  async ({ description }) => {
    try {
      setCurrentTopicDescription(description);
      return {
        content: [{ type: "text" as const, text: `Description set for "${currentTopic}".` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// --- outbound session-to-session tools ---
// Suppressed when running as a silent fork that exists only to generate an
// ask_session reply — such a fork has no reason to initiate further calls.

if (!isReplyOnly) {
  server.tool(
    "ask_session",
    "ASK — Delegate to another session and pull the result back INTO YOUR CONTEXT. Target forks (no history pollution), processes with full tools, and the answer is auto-injected into your conversation. Use ONLY when YOU need the output to drive your next action (code reviews whose verdict determines your next edit, fact checks you'll cite, lookups that decide your next step). If the user can just read the result in the target topic, use tell_session — ask burns your context window with content you don't actually need. Decision rule: 'Do I need this output in MY context to proceed?' Yes → ask. No (result lives in target topic, user reads it there) → tell_session. Use context_id to continue a previous exchange without resending.",
    {
      to: z.string().describe("Target session/topic name (e.g. '회의록', '신건')"),
      message: z.string().describe("Message to send to the target session"),
      context_id: z.string().optional().describe("Context ID from a previous ask_session exchange. Omit for new conversations."),
    },
    async ({ to, message, context_id }) => {
      // Remote target: @server-id/topic
      const remoteMatch = to.match(/^@([^/]+)\/(.+)$/);
      if (remoteMatch) {
        const [, targetServer, targetTopic] = remoteMatch;
        if (!HTML_PAGE_SERVER) {
          return { content: [{ type: "text" as const, text: "Error: HTML_PAGE_SERVER not configured — cannot route to remote server." }], isError: true };
        }
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextId = context_id || createContextId();
        try {
          const res = await fetch(`${HTML_PAGE_SERVER}/relay/ask/${encodeURIComponent(targetServer)}/${encodeURIComponent(targetTopic)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: currentTopic,
              fromServer: SERVER_NAME,
              message,
              requestId,
              contextId,
              fromDepth: currentDepth,
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({})) as { detail?: string };
            return { content: [{ type: "text" as const, text: `Error: 원격 전송 실패 — ${err.detail || res.statusText}` }], isError: true };
          }
          return {
            content: [{
              type: "text" as const,
              text: `"@${targetServer}/${targetTopic}" 원격 세션에 참조 요청을 보냈습니다.\n\ncontext_id: ${contextId}\nrequest_id: ${requestId}\n\n"${targetTopic}"의 응답이 이 세션에 자동으로 돌아옵니다.`,
            }],
          };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Error: Hub 연결 실패 — ${err?.message}` }], isError: true };
        }
      }

      if (message.length > MAX_MESSAGE_LENGTH) {
        return {
          content: [{ type: "text" as const, text: `Error: message too long (${message.length} chars, max ${MAX_MESSAGE_LENGTH})` }],
          isError: true,
        };
      }

      const topics = getTopicsForUser();
      const target = topics[to];

      if (!target) {
        const available = Object.keys(topics).filter((n) => n !== currentTopic);
        return {
          content: [{ type: "text" as const, text: `Error: Session "${to}" not found.\nAvailable sessions: ${available.join(", ") || "none"}` }],
          isError: true,
        };
      }

      if (!target.sessionId) {
        return {
          content: [{ type: "text" as const, text: `Error: Session "${to}" has no active session ID. The user needs to send a message there first.` }],
          isError: true,
        };
      }

      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const contextId = context_id || createContextId();

      try {
        const inboxDir = join(SESSION_INBOX_DIR, userId);
        mkdirSync(inboxDir, { recursive: true });
        const inboxFile = join(inboxDir, `${to}.jsonl`);
        const entry = {
          type: "ask" as const,
          requestId,
          from: currentTopic,
          message,
          contextId,
          // Caller's depth — used to resume this session at the correct depth
          // when the fork's reply is injected back.
          fromDepth: currentDepth,
          timestamp: new Date().toISOString(),
        };
        appendFileSync(inboxFile, JSON.stringify(entry) + "\n");
      } catch (err) {
        const e = err as { message?: string };
        return {
          content: [{ type: "text" as const, text: `Error: "${to}" 세션에 메시지 전송 실패: ${e?.message || "Unknown"}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: `"${to}" 세션에 참조 요청을 보냈습니다.\n\ncontext_id: ${contextId}\nrequest_id: ${requestId}\n\n"${to}"가 공유한 내용이 이 세션에 자동으로 돌아옵니다. 다음 ask_session에 context_id를 전달하면 동일 주제의 대화를 이어갈 수 있습니다.`,
        }],
      };
    }
  );

  server.tool(
    "abort_session",
    "Abort the currently running query in another session. Use peek_session first to confirm it is busy.",
    {
      to: z.string().describe("Target session/topic name to abort"),
    },
    async ({ to }) => {
      const topics = getTopicsForUser();
      if (!topics[to]) {
        const available = Object.keys(topics).filter((n) => n !== currentTopic);
        return {
          content: [{ type: "text" as const, text: `Error: Session "${to}" not found.\nAvailable: ${available.join(", ") || "none"}` }],
          isError: true,
        };
      }

      if (to === currentTopic) {
        return {
          content: [{ type: "text" as const, text: `Error: 자기 자신은 abort할 수 없습니다.` }],
          isError: true,
        };
      }

      try {
        const inboxDir = join(SESSION_INBOX_DIR, userId);
        mkdirSync(inboxDir, { recursive: true });
        appendFileSync(join(inboxDir, `${to}.jsonl`), JSON.stringify({ type: "abort", timestamp: new Date().toISOString() }) + "\n");
      } catch (err) {
        const e = err as { message?: string };
        return {
          content: [{ type: "text" as const, text: `Error: abort 신호 전송 실패: ${e?.message || "Unknown"}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `"${to}" 세션에 abort 신호를 보냈습니다. 실행 중인 쿼리가 있으면 중단됩니다.` }],
      };
    }
  );

  server.tool(
    "tell_session",
    "TELL — Delegate work or push context TO another session (one-way, nothing returns to your context). Message joins target's history; target processes async with full tools and the result lives in the target topic. Use for: delegating long-running or self-contained work (experiments, benchmarks, monitoring runs, file generation), status updates, persistent context injection — anything whose output the user can simply read in the target topic without you needing it. Prefer tell over ask_session whenever YOUR context doesn't need the result, since ask injects the full reply back and burns context. Decision rule: 'Do I need this output in MY context to proceed?' No → tell. Yes → ask_session.",
    {
      to: z.string().describe("Target session/topic name (e.g. '회의록', '신건')"),
      message: z.string().describe("Message to send to the target session"),
    },
    async ({ to, message }) => {
      // Remote target: @server-id/topic
      const remoteMatch = to.match(/^@([^/]+)\/(.+)$/);
      if (remoteMatch) {
        const [, targetServer, targetTopic] = remoteMatch;
        if (!HTML_PAGE_SERVER) {
          return { content: [{ type: "text" as const, text: "Error: HTML_PAGE_SERVER not configured — cannot route to remote server." }], isError: true };
        }
        if (currentDepth + 1 > MAX_TELL_DEPTH) {
          return { content: [{ type: "text" as const, text: `Error: depth 한도 도달 (현재 ${currentDepth}, 최대 ${MAX_TELL_DEPTH}).` }], isError: true };
        }
        try {
          const res = await fetch(`${HTML_PAGE_SERVER}/relay/tell/${encodeURIComponent(targetServer)}/${encodeURIComponent(targetTopic)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: currentTopic, fromServer: SERVER_NAME, message, depth: currentDepth + 1 }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({})) as { detail?: string };
            return { content: [{ type: "text" as const, text: `Error: 원격 전송 실패 — ${err.detail || res.statusText}` }], isError: true };
          }
          return { content: [{ type: "text" as const, text: `"@${targetServer}/${targetTopic}" 원격 세션에 메시지를 전달했습니다.` }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Error: Hub 연결 실패 — ${err?.message}` }], isError: true };
        }
      }

      if (message.length > MAX_MESSAGE_LENGTH) {
        return {
          content: [{ type: "text" as const, text: `Error: message too long (${message.length} chars, max ${MAX_MESSAGE_LENGTH})` }],
          isError: true,
        };
      }

      if (currentDepth + 1 > MAX_TELL_DEPTH) {
        return {
          content: [{ type: "text" as const, text: `Error: depth 한도 도달 (현재 ${currentDepth}, 최대 ${MAX_TELL_DEPTH}). 더 이상 tell_session 체인을 만들 수 없습니다.` }],
          isError: true,
        };
      }

      const topics = getTopicsForUser();
      const target = topics[to];

      if (!target) {
        const available = Object.keys(topics).filter((n) => n !== currentTopic);
        return {
          content: [{ type: "text" as const, text: `Error: Session "${to}" not found.\nAvailable sessions: ${available.join(", ") || "none"}` }],
          isError: true,
        };
      }

      if (!target.sessionId) {
        return {
          content: [{ type: "text" as const, text: `Error: Session "${to}" has no active session ID. The user needs to send a message there first.` }],
          isError: true,
        };
      }

      try {
        const inboxDir = join(SESSION_INBOX_DIR, userId);
        mkdirSync(inboxDir, { recursive: true });
        const inboxFile = join(inboxDir, `${to}.jsonl`);
        const entry = {
          type: "tell" as const,
          from: currentTopic,
          message,
          depth: currentDepth + 1,
          timestamp: new Date().toISOString(),
        };
        appendFileSync(inboxFile, JSON.stringify(entry) + "\n");
      } catch (err) {
        const e = err as { message?: string };
        return {
          content: [{ type: "text" as const, text: `Error: "${to}" 세션에 메시지 전송 실패: ${e?.message || "Unknown"}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: `"${to}" 세션에 메시지를 전달했습니다 (fire-and-forget, 응답 없음). "${to}"의 히스토리에 기록되고 Claude가 처리합니다. 응답이 필요하면 ask_session을 쓰세요.`,
        }],
      };
    }
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
