#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { PROJECT_ROOT, SERVER_NAME } from "@/core/config";

const execFileAsync = promisify(execFile);

/** Validate a cron expression (5 fields: min hour dom month dow) */
function isValidCron(expr: string): { valid: boolean; error?: string } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { valid: false, error: `Expected 5 fields (minute hour day month weekday), got ${fields.length}` };
  }

  const ranges: [string, number, number][] = [
    ["minute", 0, 59],
    ["hour", 0, 23],
    ["day of month", 1, 31],
    ["month", 1, 12],
    ["day of week", 0, 7],
  ];

  for (let i = 0; i < 5; i++) {
    const [name, min, max] = ranges[i];
    const field = fields[i];
    // Split by comma for lists
    for (const part of field.split(",")) {
      // Match: *, */N, N, N-N, N-N/N
      const m = part.match(/^(\*|(\d+)(-(\d+))?)(?:\/(\d+))?$/);
      if (!m) {
        return { valid: false, error: `Invalid ${name} field: "${part}"` };
      }
      if (m[2] !== undefined) {
        const val = Number(m[2]);
        if (val < min || val > max) {
          return { valid: false, error: `${name} value ${val} out of range (${min}-${max})` };
        }
      }
      if (m[4] !== undefined) {
        const val = Number(m[4]);
        if (val < min || val > max) {
          return { valid: false, error: `${name} range end ${val} out of range (${min}-${max})` };
        }
      }
      if (m[5] !== undefined) {
        const step = Number(m[5]);
        if (step === 0) {
          return { valid: false, error: `${name} step value cannot be 0` };
        }
      }
    }
  }

  return { valid: true };
}

const CRON_DIR = resolve(PROJECT_ROOT, "cron");
const RUNNER_PY = resolve(CRON_DIR, "runner.py");
const SESSIONS_DB = resolve(PROJECT_ROOT, "data", "sessions.db");

function getServerTopics(): string[] {
  if (!existsSync(SESSIONS_DB)) return [];
  const db = new Database(SESSIONS_DB, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    const rows = db.query<{ name: string }, string>(
      "SELECT name FROM topics WHERE server_name = ?"
    ).all(SERVER_NAME);
    return rows.map(r => r.name);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

// Parse CLI args
const args = process.argv.slice(2);
const userId = args.find((a) => a.startsWith("--user-id="))?.split("=")[1] || "";
const currentTopic = args.find((a) => a.startsWith("--topic="))?.split("=")[1] || "";

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

interface Pm2Process {
  name?: string;
  pm2_env?: {
    status?: string;
    cron_restart?: string;
    restart_time?: number;
  };
}

const server = new McpServer({
  name: "cron-manager",
  version: "1.0.0",
});

server.tool(
  "cron_create",
  "Create a new cron job. The script must exist in the cron/ directory. The script's stdout is used as a prompt for claude -p, which runs in the target topic's session. Results are sent to the Telegram topic.",
  {
    name: z.string().describe("Unique name for this cron job (e.g. 'email-check', 'daily-report')"),
    script: z.string().describe("Python script filename in cron/ directory (e.g. 'email_check.py')"),
    cron: z.string().describe("Cron expression (e.g. '0 9 * * *' for daily 9am, '*/5 * * * *' for every 5 min)"),
    topic: z.string().optional().describe("Telegram topic to send results to. Defaults to the current topic this session is running in."),
  },
  async ({ name, script, cron, topic: topicArg }) => {
    const topic = topicArg || currentTopic;
    if (!topic) {
      return {
        content: [{ type: "text" as const, text: `Error: No topic specified and no current topic detected. Provide a topic name explicitly.` }],
        isError: true,
      };
    }
    // Validate name — alphanumeric, dash, underscore only
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return {
        content: [{ type: "text" as const, text: `Error: Invalid name "${name}". Use only letters, numbers, dashes, and underscores.` }],
        isError: true,
      };
    }

    // Validate script — simple filename only, no path separators
    if (!/^[a-zA-Z0-9_.-]+\.py$/.test(script) || script.includes("/") || script.includes("\\")) {
      return {
        content: [{ type: "text" as const, text: `Error: Invalid script name "${script}". Must be a plain .py filename with no path separators.` }],
        isError: true,
      };
    }

    // Validate cron expression
    const cronCheck = isValidCron(cron);
    if (!cronCheck.valid) {
      return {
        content: [{ type: "text" as const, text: `Error: Invalid cron expression "${cron}"\n${cronCheck.error}\nFormat: minute(0-59) hour(0-23) day(1-31) month(1-12) weekday(0-7)\nExamples: "0 9 * * *" (daily 9am), "*/5 * * * *" (every 5 min), "0 9 * * 1-5" (weekdays 9am)` }],
        isError: true,
      };
    }

    const scriptPath = resolve(CRON_DIR, script);
    if (!scriptPath.startsWith(CRON_DIR + "/") || !existsSync(scriptPath)) {
      return {
        content: [{ type: "text" as const, text: `Error: Script not found: ${scriptPath}\nCreate the script in cron/ first.` }],
        isError: true,
      };
    }

    // Validate topic exists on this server
    const validTopics = getServerTopics();
    if (validTopics.length > 0 && !validTopics.includes(topic)) {
      return {
        content: [{ type: "text" as const, text: `Error: Topic "${topic}" not found for user ${userId}.\nAvailable topics: ${validTopics.join(", ")}\nUse one of the existing topic names.` }],
        isError: true,
      };
    }

    const jobName = pm2Name(name);

    // Check if already exists
    try {
      const list = await pm2(["jlist"]);
      const processes: Pm2Process[] = JSON.parse(list);
      if (processes.some((p) => p.name === jobName)) {
        return {
          content: [{ type: "text" as const, text: `Error: Cron job "${name}" already exists. Delete it first or use a different name.` }],
          isError: true,
        };
      }
    } catch (e) {
      console.warn(`[cron-manager] Failed to check existing jobs:`, e instanceof Error ? e.message : e);
    }

    // runner.py handles: run script → wait for unlock → claude -p --resume → outbox
    const cmd = `uv run ${shellQuote(RUNNER_PY)} --script ${shellQuote(script)} --topic ${shellQuote(topic)} --user-id ${shellQuote(userId)} --server-name ${shellQuote(SERVER_NAME)} --cron-name ${shellQuote(name)}`;

    try {
      await pm2([
        "start", cmd,
        "--name", jobName,
        "--cron", cron,
        "--no-autorestart",
        "--cwd", CRON_DIR,
      ]);

      return {
        content: [{
          type: "text" as const,
          text: `Cron job created:\n- name: ${name}\n- script: ${script}\n- topic: ${topic}\n- schedule: ${cron}\n- pm2 name: ${jobName}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error creating cron job: ${err instanceof Error ? err.message : "unknown"}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "cron_list",
  "List all cron jobs for the current user.",
  {},
  async () => {
    try {
      const list = await pm2(["jlist"]);
      const processes: Pm2Process[] = JSON.parse(list);
      const prefix = `cron-${userId}-`;
      const jobs = processes.filter((p) => p.name?.startsWith(prefix));

      if (jobs.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No cron jobs found." }],
        };
      }

      const lines = jobs.map((p) => {
        const shortName = (p.name ?? "").replace(prefix, "");
        const status = p.pm2_env?.status || "unknown";
        const cronExpr = p.pm2_env?.cron_restart || "N/A";
        const restarts = p.pm2_env?.restart_time || 0;
        return `- ${shortName}: ${status} | cron: ${cronExpr} | restarts: ${restarts}`;
      });

      return {
        content: [{ type: "text" as const, text: `Cron jobs (${jobs.length}):\n${lines.join("\n")}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error listing cron jobs: ${err instanceof Error ? err.message : "unknown"}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "cron_delete",
  "Delete a cron job by name.",
  {
    name: z.string().describe("Name of the cron job to delete"),
  },
  async ({ name }) => {
    const jobName = pm2Name(name);
    try {
      await pm2(["delete", jobName]);
      return {
        content: [{ type: "text" as const, text: `Cron job "${name}" deleted.` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error deleting cron job "${name}": ${err instanceof Error ? err.message : "unknown"}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "cron_list_topics",
  "List available Telegram topics for this user. Use these topic names when creating cron jobs.",
  {},
  async () => {
    const topics = getServerTopics();
    if (topics.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No topics found. Create a topic in Telegram first." }],
      };
    }
    return {
      content: [{ type: "text" as const, text: `Available topics (${topics.length}):\n${topics.map(t => `- ${t}`).join("\n")}` }],
    };
  }
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
      return {
        content: [{ type: "text" as const, text: output || "(no logs)" }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error reading logs for "${name}": ${err instanceof Error ? err.message : "unknown"}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
