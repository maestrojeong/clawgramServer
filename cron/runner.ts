#!/usr/bin/env bun
/**
 * Cron job runner (TypeScript).
 *
 * Executes a Python script, captures its stdout as a prompt,
 * runs runAgent() (with --resume if a cron session exists), and writes
 * the result to the user's cron outbox for bot.ts to pick up.
 *
 * Usage:
 *   bun run cron/runner.ts --script email_check.py --topic "[srv] 신건" --user-id 123 --cron-name email-check
 */

import { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAgent } from "@/core/agents";
import { buildTopicSystemPrompt, PROJECT_ROOT, SERVER_NAME, SESSIONS_DB, USERS_LOG_DIR } from "@/core/config";
import { SESSION_STALE_SEC } from "@/mcp/cron/shared";

// --- CLI args ---
function parseArg(name: string, required = false): string {
  const flag = `--${name}`;
  const eqMatch = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (eqMatch) return eqMatch.slice(flag.length + 1);
  const idx = process.argv.indexOf(flag);
  const val = idx !== -1 ? process.argv[idx + 1] : undefined;
  if (required && !val) {
    console.error(`[runner] Missing required argument: --${name}`);
    process.exit(1);
  }
  return val ?? "";
}

const scriptName = parseArg("script", true);
const topicName = parseArg("topic", true);
const userId = parseArg("user-id", true);
const cronName = parseArg("cron-name") || "unknown";

// --- Paths ---
const CRON_DIR = join(PROJECT_ROOT, "cron");
const userDir = join(USERS_LOG_DIR, userId);
const lockDir = join(userDir, "active-queries");
const cronLockDir = join(userDir, "cron-locks");
const sessionLockDir = join(cronLockDir, topicName); // topic-scoped: prevents cross-topic blocking
const outboxDir = join(userDir, "cron-outbox");
const cronRunsDir = join(userDir, "cron-runs");
const scriptPath = join(CRON_DIR, scriptName);

// --- DB helpers ---
interface TopicDbRow {
  cron_session_id: string | null;
  cwd: string | null;
  description: string | null;
  model: string | null;
  effort: string | null;
}

function readTopicRow(): TopicDbRow | null {
  if (!existsSync(SESSIONS_DB)) return null;
  try {
    const db = new Database(SESSIONS_DB, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const row = db
      .query<TopicDbRow, [string, string]>(
        "SELECT cron_session_id, cwd, description, model, effort FROM topics WHERE server_name = ? AND name = ?",
      )
      .get(SERVER_NAME, topicName);
    db.close();
    return row;
  } catch {
    return null;
  }
}

function setCronSessionId(sessionId: string | null): void {
  try {
    const db = new Database(SESSIONS_DB);
    db.exec("PRAGMA busy_timeout = 5000");
    db.query("UPDATE topics SET cron_session_id = ? WHERE server_name = ? AND name = ?").run(
      sessionId,
      SERVER_NAME,
      topicName,
    );
    db.close();
  } catch (e) {
    console.error(`[runner] Failed to save cron session ID: ${e}`);
  }
}

// --- Run counter (reset session every N runs to keep context bounded) ---
const CRON_SESSION_RESET_EVERY = 5;
const counterFile = join(cronLockDir, `${cronName}.count`);

function getRunCount(): number {
  try {
    return Number.parseInt(readFileSync(counterFile, "utf-8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function incrementRunCount(): number {
  mkdirSync(cronLockDir, { recursive: true });
  const next = getRunCount() + 1;
  writeFileSync(counterFile, String(next));
  return next;
}

// --- Run history (last 20 runs) ---
const RUN_HISTORY_MAX = 20;

function appendRunHistory(entry: {
  at: string;
  exit_code: number;
  duration_ms: number;
  output_preview: string;
}): void {
  mkdirSync(cronRunsDir, { recursive: true });
  const runsFile = join(cronRunsDir, `${cronName}.jsonl`);
  if (existsSync(runsFile)) {
    try {
      const lines = readFileSync(runsFile, "utf-8").trim().split("\n").filter(Boolean);
      if (lines.length >= RUN_HISTORY_MAX) {
        writeFileSync(runsFile, `${lines.slice(-(RUN_HISTORY_MAX - 1)).join("\n")}\n`);
      }
    } catch {}
  }
  appendFileSync(runsFile, `${JSON.stringify(entry)}\n`);
}

// --- Session lock (topic-scoped: O_EXCL-atomic; steal if stale) ---
const sessionLockFile = join(sessionLockDir, "_session.lock");

function isSessionLockStale(): boolean {
  try {
    const ts = Number(readFileSync(sessionLockFile, "utf-8").trim());
    return Number.isNaN(ts) || Date.now() / 1000 - ts > SESSION_STALE_SEC;
  } catch {
    return true;
  }
}

/**
 * Wait for session lock to clear, then acquire atomically.
 * `wx` flag gives us O_EXCL so two concurrent runners can't both "acquire" after
 * reading an empty slot. On EEXIST we check staleness (steal if expired) and retry.
 */
async function acquireSessionLockWithWait(timeoutMs = 60_000): Promise<boolean> {
  mkdirSync(sessionLockDir, { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      writeFileSync(sessionLockFile, String(Date.now() / 1000), { flag: "wx" });
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      if (isSessionLockStale()) {
        try { unlinkSync(sessionLockFile); } catch {}
        continue;
      }
      if (Date.now() - start > timeoutMs) return false;
      await Bun.sleep(5000);
    }
  }
}

function releaseSessionLock(): void {
  try { if (existsSync(sessionLockFile)) unlinkSync(sessionLockFile); } catch {}
}

// --- Topic lock (bot's active-queries state file) ---
function isTopicLocked(): boolean {
  const stateFile = join(lockDir, `${topicName}.json`);
  if (!existsSync(stateFile)) return false;
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8")) as { since: string };
    if (Date.now() - new Date(state.since).getTime() > 600_000) {
      unlinkSync(stateFile);
      return false;
    }
  } catch {}
  return true;
}

async function waitForTopicUnlock(timeoutMs = 300_000): Promise<boolean> {
  const start = Date.now();
  while (isTopicLocked()) {
    if (Date.now() - start > timeoutMs) {
      console.error(`[runner] Timeout waiting for unlock: ${userId}-${topicName}`);
      return false;
    }
    await Bun.sleep(5000);
  }
  return true;
}

// --- Outbox ---
function writeOutbox(message: string, newSessionId?: string): void {
  mkdirSync(outboxDir, { recursive: true });
  const entry: Record<string, unknown> = {
    userId,
    topic: topicName,
    cronName,
    message,
    timestamp: new Date().toISOString().slice(0, 19),
  };
  if (newSessionId) entry.newCronSessionId = newSessionId;
  appendFileSync(join(outboxDir, "pending.jsonl"), `${JSON.stringify(entry)}\n`);
}

// --- Main ---
async function main() {
  if (!existsSync(scriptPath)) {
    console.error(`[runner] Script not found: ${scriptPath}`);
    process.exit(1);
  }

  // Skip-first marker: set by cron-manager on create/restart to suppress pm2's
  // immediate-on-start execution. Consume it once and exit without firing.
  const skipFirstMarker = join(cronLockDir, `${cronName}.skip-first`);
  if (existsSync(skipFirstMarker)) {
    try { unlinkSync(skipFirstMarker); } catch {}
    console.error(`[runner] Suppressing first run after registration (${cronName}); next run will fire at scheduled tick.`);
    process.exit(0);
  }

  // Job lock (prevent same job overlapping)
  mkdirSync(cronLockDir, { recursive: true });
  const jobLock = join(cronLockDir, `${cronName}.lock`);
  if (existsSync(jobLock)) {
    try {
      const ts = Number(readFileSync(jobLock, "utf-8").trim());
      if (!Number.isNaN(ts) && Date.now() / 1000 - ts < SESSION_STALE_SEC) {
        console.error(`[runner] Skipping: ${cronName} is already running`);
        process.exit(0);
      }
    } catch {}
  }
  writeFileSync(jobLock, String(Date.now() / 1000));

  try {
    await runJob();
  } finally {
    try { unlinkSync(jobLock); } catch {}
  }
}

async function runJob() {
  const topicRow = readTopicRow();
  // ~/ 등 tilde 확장 처리 (Bun.spawnSync는 shell expansion 미지원)
  const rawCwd = topicRow?.cwd || homedir();
  const workDir = rawCwd.replace(/^~/, homedir());

  // 1. Run Python script to get prompt
  // uv 절대경로 사용 (pm2 환경에서 ~/.local/bin이 PATH에 없을 수 있음)
  const uvBin = `${homedir()}/.local/bin/uv`;
  const proc = Bun.spawnSync([uvBin, "run", "--project", CRON_DIR, "python", scriptPath], {
    cwd: workDir,
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    throw new Error(`Script exited with code ${proc.exitCode}: ${stderr}`);
  }
  const prompt = new TextDecoder().decode(proc.stdout).trim();
  if (!prompt) {
    console.error("[runner] Script produced no output (normal - nothing to report)");
    return;
  }

  // 2. Wait for interactive topic to unlock
  if (!(await waitForTopicUnlock())) {
    writeOutbox(`[cron skipped] Topic '${topicName}' was busy for too long.`);
    return;
  }

  // 3. Acquire session lock atomically BEFORE session reset / getCronSessionId —
  //    otherwise a concurrent finisher could overwrite our NULL reset or hand us
  //    a stale session id mid-flight.
  if (!(await acquireSessionLockWithWait())) {
    writeOutbox(`[cron skipped] Cron session busy for too long (${cronName}).`);
    return;
  }

  // 4. Session reset every N runs (bounded context window)
  const runCount = incrementRunCount();
  if (runCount % CRON_SESSION_RESET_EVERY === 0) {
    console.error(`[runner] Run ${runCount}: resetting cron session`);
    setCronSessionId(null);
  }

  const freshRow = readTopicRow();
  const cronSessionId = freshRow?.cron_session_id ?? null;

  let response = "";
  let newSessionId: string | undefined;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let exitCode = 0;

  try {
    for await (const event of runAgent({
      prompt,
      sessionId: cronSessionId,
      cwd: workDir,
      userId,
      session: topicName,
      sessionType: "forum",
      systemPrompt: buildTopicSystemPrompt({ description: freshRow?.description ?? null }),
      ...(freshRow?.model && { model: freshRow.model }),
      ...(freshRow?.effort && { effort: freshRow.effort as "low" | "medium" | "high" | "max" }),
    })) {
      switch (event.type) {
        case "session":
          newSessionId = event.sessionId;
          break;
        case "result":
          response = event.content;
          break;
      }
    }
  } catch (e) {
    response = `[cron error] ${e}`;
    exitCode = 1;
  } finally {
    releaseSessionLock();

    if (!response) response = "(empty response)";
    const durationMs = Date.now() - startMs;

    writeOutbox(response, newSessionId);
    if (newSessionId) setCronSessionId(newSessionId);
    appendRunHistory({
      at: startedAt,
      exit_code: exitCode,
      duration_ms: durationMs,
      output_preview: response.slice(0, 150),
    });

    console.error(`[runner] Done. Output written to outbox for topic '${topicName}'`);
  }
}

main().catch((e) => {
  console.error(`[runner] Fatal error: ${e}`);
  process.exit(1);
});
