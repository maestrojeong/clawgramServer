#!/usr/bin/env node
/**
 * DM-only cron admin MCP server.
 * Cross-topic: no ownership checks, full visibility over all cron jobs for this user.
 * Tools: cron_status, cron_kill, cron_reset
 */
import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PROJECT_ROOT, SERVER_NAME, SESSIONS_DB, USERS_LOG_DIR } from "@/core/config";
import { mcpError, mcpOk, parseUserIdArg } from "@/mcp/mcp-helpers";
import { getServerTopics, readLockFile, readMeta } from "@/mcp/cron/shared";

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const userId = parseUserIdArg(args);

const USER_DIR = join(USERS_LOG_DIR, userId);
const CRON_LOCK_DIR = join(USER_DIR, "cron-locks");
const CRON_META_DIR = join(USER_DIR, "cron-meta");

function getRunCount(name: string): number {
  const f = join(CRON_LOCK_DIR, `${name}.count`);
  if (!existsSync(f)) return 0;
  return Number.parseInt(readFileSync(f, "utf-8").trim(), 10) || 0;
}

function pm2Name(name: string): string {
  return `cron-${userId}-${name}`;
}

async function getPm2StatusMap(): Promise<Record<string, string>> {
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"], {
      cwd: PROJECT_ROOT,
      timeout: 15000,
    });
    const processes = JSON.parse(stdout.trim()) as Array<{
      name?: string;
      pm2_env?: { status?: string };
    }>;
    return Object.fromEntries(
      processes
        .filter((p) => p.name?.startsWith(`cron-${userId}-`))
        .map((p) => [p.name as string, p.pm2_env?.status ?? "unknown"]),
    );
  } catch {
    return {};
  }
}

function getLastOutputPreview(name: string): string | null {
  const runsFile = join(USER_DIR, "cron-runs", `${name}.jsonl`);
  if (!existsSync(runsFile)) return null;
  try {
    const lines = readFileSync(runsFile, "utf-8").trim().split("\n").filter(Boolean);
    const last = lines.at(-1);
    if (!last) return null;
    const parsed = JSON.parse(last) as { output_preview?: string };
    return parsed.output_preview ?? null;
  } catch {
    return null;
  }
}

// --- MCP Server ---

const server = new McpServer({ name: "cron-dm", version: "1.0.0" });

server.tool(
  "cron_status",
  "Show all cron jobs across all topics for this user. Includes lock status, run count, and last output preview.",
  {},
  async () => {
    const metaFiles = existsSync(CRON_META_DIR)
      ? readdirSync(CRON_META_DIR).filter((f) => f.endsWith(".json"))
      : [];

    if (metaFiles.length === 0) return mcpOk("No cron jobs registered.");

    const topics = getServerTopics();
    const topicSet = new Set(topics);
    const pm2StatusMap = await getPm2StatusMap();

    const byTopic: Record<string, unknown[]> = {};

    for (const f of metaFiles) {
      const name = f.replace(".json", "");
      const meta = readMeta(CRON_META_DIR, name);
      if (!meta) continue;

      const sessionLock = readLockFile(join(CRON_LOCK_DIR, meta.topic, "_session.lock"));
      const jobLock = readLockFile(join(CRON_LOCK_DIR, `${name}.lock`));

      if (!byTopic[meta.topic]) byTopic[meta.topic] = [];
      byTopic[meta.topic].push({
        name,
        script: meta.script,
        cron: meta.cron,
        pm2_status: pm2StatusMap[pm2Name(name)] ?? "not found",
        topic_exists: topicSet.has(meta.topic),
        session_lock_held: sessionLock.held,
        session_lock_stale: sessionLock.stale,
        job_lock_held: jobLock.held,
        job_lock_stale: jobLock.stale,
        run_count: getRunCount(name),
        last_output_preview: getLastOutputPreview(name),
      });
    }

    return mcpOk(JSON.stringify(byTopic, null, 2));
  },
);

server.tool(
  "cron_kill",
  "Clear stuck locks for a cron job. Admin version: no topic ownership check. Clears session lock for the job's topic and optionally the job lock.",
  {
    job_name: z.string().describe("Name of the cron job to clear locks for"),
    session_only: z.boolean().optional().describe("If true, clear session lock only (not job lock). Default: clear both."),
  },
  async ({ job_name, session_only }) => {
    const meta = readMeta(CRON_META_DIR, job_name);
    if (!meta) {
      return mcpError(`Error: No meta file found for "${job_name}". Use cron_status to list jobs.`);
    }

    const cleared: string[] = [];

    const sessionLockFile = join(CRON_LOCK_DIR, meta.topic, "_session.lock");
    if (existsSync(sessionLockFile)) {
      try {
        unlinkSync(sessionLockFile);
        cleared.push(`session lock (topic: ${meta.topic})`);
      } catch (e) {
        return mcpError(`Error clearing session lock: ${e instanceof Error ? e.message : e}`);
      }
    }

    if (!session_only) {
      const jobLockFile = join(CRON_LOCK_DIR, `${job_name}.lock`);
      if (existsSync(jobLockFile)) {
        try {
          unlinkSync(jobLockFile);
          cleared.push(`job lock (${job_name})`);
        } catch (e) {
          return mcpError(`Error clearing job lock: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    if (cleared.length === 0) return mcpOk(`No locks held for "${job_name}". Nothing to clear.`);
    return mcpOk(`Cleared: ${cleared.join(", ")}.`);
  },
);

server.tool(
  "cron_reset",
  "Reset the cron session for a topic. Clears cron_session_id in DB and resets run counters for all jobs in the topic.",
  {
    topic: z.string().describe("Topic name to reset cron session for"),
  },
  async ({ topic }) => {
    if (!existsSync(SESSIONS_DB)) return mcpError("Error: Sessions DB not found.");

    try {
      const db = new Database(SESSIONS_DB);
      db.exec("PRAGMA busy_timeout = 5000");
      const result = db
        .query("UPDATE topics SET cron_session_id = NULL WHERE server_name = ? AND name = ?")
        .run(SERVER_NAME, topic);
      db.close();
      if (result.changes === 0) {
        return mcpError(`Error: Topic "${topic}" not found. Use cron_status to see available topics.`);
      }
    } catch (e) {
      return mcpError(`Error resetting session: ${e instanceof Error ? e.message : e}`);
    }

    const resetJobs: string[] = [];
    if (existsSync(CRON_META_DIR)) {
      for (const f of readdirSync(CRON_META_DIR).filter((f) => f.endsWith(".json"))) {
        const name = f.replace(".json", "");
        const meta = readMeta(CRON_META_DIR, name);
        if (!meta || meta.topic !== topic) continue;
        const counterFile = join(CRON_LOCK_DIR, `${name}.count`);
        if (existsSync(counterFile)) {
          try {
            writeFileSync(counterFile, "0");
            resetJobs.push(name);
          } catch {}
        }
      }
    }

    const jobNote = resetJobs.length > 0 ? ` Counters reset: ${resetJobs.join(", ")}.` : "";
    return mcpOk(`Cron session reset for topic "${topic}". Next run starts fresh.${jobNote}`);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
