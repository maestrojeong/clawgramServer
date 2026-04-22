#!/usr/bin/env node
import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PROJECT_ROOT, SERVER_NAME, SESSIONS_DB, USERS_LOG_DIR } from "@/core/config";
import { mcpError, mcpOk, parseUserIdArg } from "@/mcp/mcp-helpers";
import {
  computeNextRun,
  type CronMeta,
  deleteMeta,
  getServerTopics,
  isValidCron,
  readLockFile,
  readMeta,
  SESSION_STALE_SEC,
  writeMeta,
} from "@/mcp/cron/shared";

const execFileAsync = promisify(execFile);

// --- Paths ---
const CRON_DIR = resolve(PROJECT_ROOT, "cron");
const RUNNER_TS = resolve(CRON_DIR, "runner.ts");
const HOME = homedir();

const args = process.argv.slice(2);
const userId = parseUserIdArg(args);
const currentTopic = args.find((a) => a.startsWith("--topic="))?.split("=")[1] || "";

const USER_DIR = join(USERS_LOG_DIR, userId);
const CRON_LOCK_DIR = join(USER_DIR, "cron-locks");
const CRON_META_DIR = join(USER_DIR, "cron-meta");

function pm2Name(name: string): string {
  return `cron-${userId}-${name}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function pm2(pmArgs: string[]): Promise<string> {
  const { stdout } = await execFileAsync("pm2", pmArgs, {
    cwd: PROJECT_ROOT,
    timeout: 15000,
  });
  return stdout.trim();
}

async function pm2Save(): Promise<void> {
  await pm2(["save"]).catch((e) =>
    process.stderr.write(`warn: cron-manager: pm2 save failed: ${e}\n`),
  );
}

interface Pm2Process {
  name?: string;
  pm2_env?: {
    status?: string;
    cron_restart?: string;
    restart_time?: number;
  };
}

// --- MCP Server ---

const server = new McpServer({
  name: "cron-manager",
  version: "1.0.0",
});

server.tool(
  "cron_create",
  "Create a new cron job. The script must exist in the cron/ directory. The script's stdout is used as a prompt for claudeQuery(), which runs in the target topic's cron session. Results are sent to the Telegram topic.",
  {
    name: z.string().describe("Unique name for this cron job (e.g. 'email-check', 'daily-report')"),
    script: z.string().describe("Python script filename in cron/ directory (e.g. 'email_check.py')"),
    cron: z.string().describe("Cron expression (e.g. '0 9 * * *' for daily 9am, '*/5 * * * *' for every 5 min)"),
    topic: z.string().optional().describe("Telegram topic to send results to. Defaults to the current topic this session is running in."),
  },
  async ({ name, script, cron, topic: topicArg }) => {
    const topic = topicArg || currentTopic;
    if (!topic) {
      return mcpError(`Error: No topic specified and no current topic detected. Provide a topic name explicitly.`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return mcpError(`Error: Invalid name "${name}". Use only letters, numbers, dashes, and underscores.`);
    }
    if (!/^[a-zA-Z0-9_.-]+\.py$/.test(script) || script.includes("/") || script.includes("\\")) {
      return mcpError(`Error: Invalid script name "${script}". Must be a plain .py filename with no path separators.`);
    }

    const cronCheck = isValidCron(cron);
    if (!cronCheck.valid) {
      return mcpError(
        `Error: Invalid cron expression "${cron}"\n${cronCheck.error}\nFormat: minute(0-59) hour(0-23) day(1-31) month(1-12) weekday(0-7)\nExamples: "0 9 * * *" (daily 9am), "*/5 * * * *" (every 5 min), "0 9 * * 1-5" (weekdays 9am)`,
      );
    }

    const scriptPath = resolve(CRON_DIR, script);
    if (!scriptPath.startsWith(`${CRON_DIR}/`) || !existsSync(scriptPath)) {
      return mcpError(`Error: Script not found: ${scriptPath}\nCreate the script in cron/ first.`);
    }

    const validTopics = getServerTopics();
    if (validTopics.length > 0 && !validTopics.includes(topic)) {
      return mcpError(
        `Error: Topic "${topic}" not found on this server.\nAvailable topics: ${validTopics.join(", ")}\nUse one of the existing topic names.`,
      );
    }

    const jobName = pm2Name(name);
    try {
      const list = await pm2(["jlist"]);
      const processes: Pm2Process[] = JSON.parse(list);
      if (processes.some((p) => p.name === jobName)) {
        return mcpError(`Error: Cron job "${name}" already exists. Delete it first or use a different name.`);
      }
    } catch (e) {
      process.stderr.write(`warn: cron-manager: failed to check existing jobs: ${e instanceof Error ? e.message : e}\n`);
    }

    const cmd = `bun run ${shellQuote(RUNNER_TS)} --script ${shellQuote(script)} --topic ${shellQuote(topic)} --user-id ${shellQuote(userId)} --cron-name ${shellQuote(name)}`;

    // Suppress pm2's immediate-on-start execution: runner.ts consumes this
    // marker on its first invocation and exits before spawning Python / claudeQuery.
    const skipMarker = join(CRON_LOCK_DIR, `${name}.skip-first`);
    try {
      mkdirSync(CRON_LOCK_DIR, { recursive: true });
      writeFileSync(skipMarker, String(Date.now()));
    } catch (e) {
      process.stderr.write(`warn: cron-manager: failed to write skip-first marker: ${e instanceof Error ? e.message : e}\n`);
    }

    try {
      await pm2([
        "start", cmd,
        "--name", jobName,
        "--cron", cron,
        "--no-autorestart",
        "--cwd", CRON_DIR,
      ]);
      await pm2Save();
      writeMeta(CRON_META_DIR, name, { topic, script, cron });

      return mcpOk(
        `Cron job created:\n- name: ${name}\n- script: ${script}\n- topic: ${topic}\n- schedule: ${cron}\n- pm2 name: ${jobName}\n- first run suppressed; next run at scheduled tick`,
      );
    } catch (err) {
      try { unlinkSync(skipMarker); } catch {}
      return mcpError(`Error creating cron job: ${err instanceof Error ? err.message : "unknown"}`);
    }
  },
);

server.tool("cron_list", "List all cron jobs for the current user.", {}, async () => {
  try {
    const list = await pm2(["jlist"]);
    const processes: Pm2Process[] = JSON.parse(list);
    const prefix = `cron-${userId}-`;
    const jobs = processes.filter((p) => p.name?.startsWith(prefix));

    if (jobs.length === 0) return mcpOk("No cron jobs found.");

    const lines = jobs.map((p) => {
      const shortName = (p.name ?? "").replace(prefix, "");
      const status = p.pm2_env?.status || "unknown";
      const cronExpr = p.pm2_env?.cron_restart || "N/A";
      const restarts = p.pm2_env?.restart_time || 0;
      const meta = readMeta(CRON_META_DIR, shortName);
      const topic = meta?.topic ?? "?";
      return `- ${shortName} [${topic}]: ${status} | cron: ${cronExpr} | restarts: ${restarts}`;
    });

    return mcpOk(`Cron jobs (${jobs.length}):\n${lines.join("\n")}`);
  } catch (err) {
    return mcpError(`Error listing cron jobs: ${err instanceof Error ? err.message : "unknown"}`);
  }
});

server.tool(
  "cron_delete",
  "Delete a cron job by name.",
  { name: z.string().describe("Name of the cron job to delete") },
  async ({ name }) => {
    const jobName = pm2Name(name);
    try {
      await pm2(["delete", jobName]);
      await pm2Save();
      deleteMeta(CRON_META_DIR, name);
      return mcpOk(`Cron job "${name}" deleted.`);
    } catch (err) {
      return mcpError(`Error deleting cron job "${name}": ${err instanceof Error ? err.message : "unknown"}`);
    }
  },
);

server.tool(
  "cron_list_topics",
  "List available Telegram topics on this server. Use these topic names when creating cron jobs.",
  {},
  async () => {
    const topics = getServerTopics();
    if (topics.length === 0) return mcpOk("No topics found. Create a topic in Telegram first.");
    return mcpOk(`Available topics (${topics.length}):\n${topics.map((t) => `- ${t}`).join("\n")}`);
  },
);

server.tool(
  "cron_logs",
  "View recent logs for a cron job.",
  {
    name: z.string().describe("Name of the cron job"),
    lines: z.number().optional().describe("Number of log lines to show (default: 30)"),
  },
  async ({ name, lines }) => {
    const jobName = pm2Name(name);
    const n = lines || 30;
    try {
      const output = await pm2(["logs", jobName, "--lines", String(n), "--nostream"]);
      return mcpOk(output || "(no logs)");
    } catch (err) {
      return mcpError(`Error reading logs for "${name}": ${err instanceof Error ? err.message : "unknown"}`);
    }
  },
);

server.tool(
  "cron_inspect",
  "Inspect the cron session and all cron jobs for the current topic. Shows session health, lock status, run history, and recent output.",
  {},
  async () => {
    if (!currentTopic) return mcpError("Error: No current topic.");

    // 1. Cron session ID from DB
    let sessionId: string | null = null;
    if (existsSync(SESSIONS_DB)) {
      try {
        const db = new Database(SESSIONS_DB, { readonly: true });
        db.exec("PRAGMA busy_timeout = 3000");
        const row = db
          .query<{ cron_session_id: string | null; cwd: string | null }, [string, string]>(
            "SELECT cron_session_id, cwd FROM topics WHERE server_name = ? AND name = ?",
          )
          .get(SERVER_NAME, currentTopic);
        db.close();
        sessionId = row?.cron_session_id ?? null;
      } catch {}
    }

    // 2. Session file mtime (best-effort: the SDK stores jsonl under ~/.claude/projects/<escaped-cwd>/)
    let sessionLastSeen: string | null = null;
    let sessionIsAlive = false;
    if (sessionId) {
      try {
        // Probe any .claude/projects directory for this session id — cwd-escape varies.
        const projects = join(HOME, ".claude", "projects");
        if (existsSync(projects)) {
          for (const entry of readdirSync(projects)) {
            const candidate = join(projects, entry, `${sessionId}.jsonl`);
            if (existsSync(candidate)) {
              const mtime = statSync(candidate).mtime;
              sessionLastSeen = mtime.toISOString();
              sessionIsAlive = Date.now() - mtime.getTime() < SESSION_STALE_SEC * 1000;
              break;
            }
          }
        }
      } catch {}
    }

    // 3. Session lock — topic-scoped
    const sessionLock = readLockFile(join(CRON_LOCK_DIR, currentTopic, "_session.lock"));

    // 4. Outbox pending (this topic)
    const outboxFile = join(USER_DIR, "cron-outbox", "pending.jsonl");
    let outboxPending = 0;
    if (existsSync(outboxFile)) {
      try {
        const lines = readFileSync(outboxFile, "utf-8").trim().split("\n").filter(Boolean);
        outboxPending = lines.filter((l) => {
          try { return JSON.parse(l).topic === currentTopic; } catch { return false; }
        }).length;
      } catch {}
    }

    // 5. pm2 status map
    const pm2StatusMap: Record<string, string> = {};
    const pm2CronMap: Record<string, string> = {};
    let allPm2Processes: Pm2Process[] = [];
    try {
      const list = await pm2(["jlist"]);
      allPm2Processes = JSON.parse(list) as Pm2Process[];
      for (const p of allPm2Processes) {
        if (p.name) {
          pm2StatusMap[p.name] = p.pm2_env?.status ?? "unknown";
          pm2CronMap[p.name] = p.pm2_env?.cron_restart ?? "";
        }
      }
    } catch {}

    // 6. Jobs: meta files for this topic
    const jobs: unknown[] = [];
    const seenNames = new Set<string>();

    if (existsSync(CRON_META_DIR)) {
      for (const f of readdirSync(CRON_META_DIR).filter((f) => f.endsWith(".json"))) {
        let meta: CronMeta;
        try {
          meta = JSON.parse(readFileSync(join(CRON_META_DIR, f), "utf-8")) as CronMeta;
        } catch {
          continue;
        }
        if (meta.topic !== currentTopic) continue;

        const name = f.replace(".json", "");
        seenNames.add(name);

        const jobLock = readLockFile(join(CRON_LOCK_DIR, `${name}.lock`));

        const runsFile = join(USER_DIR, "cron-runs", `${name}.jsonl`);
        let last5Runs: unknown[] = [];
        let lastOutputPreview: string | null = null;
        if (existsSync(runsFile)) {
          try {
            const runs = readFileSync(runsFile, "utf-8")
              .trim().split("\n").filter(Boolean)
              .map((l) => { try { return JSON.parse(l); } catch { return null; } })
              .filter(Boolean);
            last5Runs = runs.slice(-5).reverse();
            const lastRun = runs.at(-1) as { output_preview?: string } | undefined;
            lastOutputPreview = lastRun?.output_preview ?? null;
          } catch {}
        }

        let runCount = 0;
        const counterFile = join(CRON_LOCK_DIR, `${name}.count`);
        if (existsSync(counterFile)) {
          runCount = Number.parseInt(readFileSync(counterFile, "utf-8").trim(), 10) || 0;
        }

        jobs.push({
          name,
          pm2_status: pm2StatusMap[pm2Name(name)] ?? "not found",
          script_path: join(CRON_DIR, meta.script),
          script_exists: existsSync(join(CRON_DIR, meta.script)),
          job_lock_held: jobLock.held,
          job_lock_acquired_at: jobLock.acquiredAt,
          job_lock_stale: jobLock.stale,
          run_count: runCount,
          next_run_at: computeNextRun(meta.cron),
          last_5_runs: last5Runs,
          last_output_preview: lastOutputPreview,
        });
      }
    }

    // 7. Surface pm2 jobs with no meta (orphans / other-topic)
    const prefix = `cron-${userId}-`;
    for (const p of allPm2Processes) {
      if (!p.name?.startsWith(prefix)) continue;
      const name = p.name.slice(prefix.length);
      if (seenNames.has(name)) continue;
      jobs.push({
        name,
        pm2_status: pm2StatusMap[p.name] ?? "unknown",
        meta_missing: true,
        warning: "pm2 job exists but no meta file found — may be from a different topic or orphaned",
        cron: pm2CronMap[p.name] ?? null,
      });
    }

    const result = {
      session_id: sessionId,
      session_last_seen: sessionLastSeen,
      session_is_alive: sessionIsAlive,
      session_lock_held: sessionLock.held,
      session_lock_acquired_at: sessionLock.acquiredAt,
      session_lock_stale: sessionLock.stale,
      outbox_pending: outboxPending,
      jobs,
    };

    return mcpOk(JSON.stringify(result, null, 2));
  },
);

server.tool(
  "cron_kill",
  "Clear stuck locks for the current topic's cron session. Clears the session lock and optionally a specific job lock. Use when cron is stuck due to a crash.",
  {
    job_name: z.string().optional().describe("Job name to also clear the job lock for. Omit to clear session lock only."),
  },
  async ({ job_name }) => {
    if (!currentTopic) return mcpError("Error: No current topic.");
    const cleared: string[] = [];

    const sessionLockFile = join(CRON_LOCK_DIR, currentTopic, "_session.lock");
    if (existsSync(sessionLockFile)) {
      try {
        unlinkSync(sessionLockFile);
        cleared.push("session lock");
      } catch (e) {
        return mcpError(`Error clearing session lock: ${e instanceof Error ? e.message : e}`);
      }
    }

    if (job_name) {
      const meta = readMeta(CRON_META_DIR, job_name);
      if (!meta) {
        return mcpError(`Error: No meta file found for "${job_name}". Cannot verify ownership. Use cron_list to see registered jobs.`);
      }
      if (meta.topic !== currentTopic) {
        return mcpError(`Error: "${job_name}" does not belong to topic "${currentTopic}".`);
      }
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

    if (cleared.length === 0) return mcpOk("No locks were held. Nothing to clear.");
    return mcpOk(`Cleared: ${cleared.join(", ")}.`);
  },
);

server.tool(
  "cron_reset",
  "Reset the cron session for the current topic. Clears cron_session_id so the next run starts a fresh session. Also resets run counters for all jobs in this topic.",
  {},
  async () => {
    if (!currentTopic) return mcpError("Error: No current topic.");
    if (!existsSync(SESSIONS_DB)) return mcpError("Error: Sessions DB not found.");
    try {
      const db = new Database(SESSIONS_DB);
      db.exec("PRAGMA busy_timeout = 5000");
      db.query("UPDATE topics SET cron_session_id = NULL WHERE server_name = ? AND name = ?").run(
        SERVER_NAME, currentTopic,
      );
      db.close();
    } catch (e) {
      return mcpError(`Error resetting session: ${e instanceof Error ? e.message : e}`);
    }

    const resetJobs: string[] = [];
    if (existsSync(CRON_META_DIR)) {
      for (const f of readdirSync(CRON_META_DIR).filter((f) => f.endsWith(".json"))) {
        try {
          const meta = JSON.parse(readFileSync(join(CRON_META_DIR, f), "utf-8")) as CronMeta;
          if (meta.topic !== currentTopic) continue;
          const name = f.replace(".json", "");
          const counterFile = join(CRON_LOCK_DIR, `${name}.count`);
          if (existsSync(counterFile)) {
            writeFileSync(counterFile, "0");
            resetJobs.push(name);
          }
        } catch {}
      }
    }

    const jobNote = resetJobs.length > 0 ? ` Run counters reset: ${resetJobs.join(", ")}.` : "";
    return mcpOk(`Cron session reset for topic "${currentTopic}". Next run will start fresh.${jobNote}`);
  },
);

server.tool(
  "cron_restart",
  "Restart a cron job via pm2 to refresh its schedule registration. The first run after restart is suppressed to prevent unintended token consumption; the job fires only at its next scheduled tick.",
  {
    name: z.string().describe("Name of the cron job to restart"),
  },
  async ({ name }) => {
    const meta = readMeta(CRON_META_DIR, name);
    if (!meta) {
      return mcpError(`Error: No meta file found for "${name}". Cannot verify ownership. Use cron_list to see registered jobs.`);
    }
    if (meta.topic !== currentTopic) {
      return mcpError(`Error: "${name}" does not belong to topic "${currentTopic}".`);
    }
    const jobName = pm2Name(name);
    const skipMarker = join(CRON_LOCK_DIR, `${name}.skip-first`);
    try {
      mkdirSync(CRON_LOCK_DIR, { recursive: true });
      writeFileSync(skipMarker, String(Date.now()));
    } catch (e) {
      process.stderr.write(`warn: cron-manager: failed to write skip-first marker: ${e instanceof Error ? e.message : e}\n`);
    }
    try {
      await pm2(["restart", jobName]);
      return mcpOk(`Cron job "${name}" restarted. First run suppressed; will fire at next scheduled tick.`);
    } catch (err) {
      try { unlinkSync(skipMarker); } catch {}
      return mcpError(`Error restarting "${name}": ${err instanceof Error ? err.message : "unknown"}`);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
