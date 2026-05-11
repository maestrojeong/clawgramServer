import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLAYWRIGHT_BASE_PORT,
  PLAYWRIGHT_MAX_PORT,
  PLAYWRIGHT_MCP_BIN,
  PLAYWRIGHT_PORTS_DIR,
  PLAYWRIGHT_PROFILES_DIR,
} from "@/core/config";
import { delay } from "@/core/delay";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STEALTH_SCRIPT = resolve(__dirname, "stealth.js");

import { logger } from "@/core/logger";
import { sanitizeTopicName } from "@/core/sanitize";

export { PLAYWRIGHT_PORTS_DIR };

/**
 * Build an instanceKey from its (userId, groupId, topic) parts. Phase-2
 * multi-group: the groupId is part of the key so group A's "research" and
 * group B's "research" don't share a Playwright process or Chrome profile.
 *
 * Forms:
 *   - `${uid}`                     — user-level (no topic)
 *   - `${uid}::${topic}`           — DM / topic without a group
 *   - `${uid}:${groupId}:${topic}` — forum topic
 */
function makeInstanceKey(
  userId: string,
  groupId: number | undefined,
  topic: string | undefined,
): string {
  if (!topic) return userId;
  return groupId !== undefined ? `${userId}:${groupId}:${topic}` : `${userId}::${topic}`;
}

interface InstanceKeyParts {
  userId: string;
  groupId: number | undefined;
  topic: string | undefined;
}

function parseInstanceKey(instanceKey: string): InstanceKeyParts {
  const firstColon = instanceKey.indexOf(":");
  if (firstColon === -1) return { userId: instanceKey, groupId: undefined, topic: undefined };
  const userId = instanceKey.slice(0, firstColon);
  const rest = instanceKey.slice(firstColon + 1);
  if (rest.startsWith(":")) {
    // `${uid}::${topic}` — topic without group
    return { userId, groupId: undefined, topic: rest.slice(1) || undefined };
  }
  const secondColon = rest.indexOf(":");
  if (secondColon === -1) {
    // `${uid}:${topic}` — legacy single-group form
    return { userId, groupId: undefined, topic: rest };
  }
  const groupStr = rest.slice(0, secondColon);
  const topic = rest.slice(secondColon + 1);
  const groupNum = Number(groupStr);
  return {
    userId,
    groupId: Number.isFinite(groupNum) ? groupNum : undefined,
    topic: topic || undefined,
  };
}

function portFileName(instanceKey: string): string {
  const { userId, groupId, topic } = parseInstanceKey(instanceKey);
  if (!topic) return sanitizeTopicName(userId);
  const t = sanitizeTopicName(topic);
  return groupId !== undefined ? `${userId}_${groupId}_${t}` : `${userId}_${t}`;
}

function writePortFile(instanceKey: string, port: number) {
  try {
    mkdirSync(PLAYWRIGHT_PORTS_DIR, { recursive: true });
    writeFileSync(join(PLAYWRIGHT_PORTS_DIR, portFileName(instanceKey)), String(port));
  } catch (e) {
    logger.warn({ err: e, instanceKey, port }, "Failed to save playwright port file");
  }
}

function deletePortFile(instanceKey: string) {
  try {
    unlinkSync(join(PLAYWRIGHT_PORTS_DIR, portFileName(instanceKey)));
  } catch (e) {
    logger.warn({ err: e, instanceKey }, "Failed to delete playwright port file");
  }
}

const BASE_PORT = PLAYWRIGHT_BASE_PORT;
const MAX_PORT = PLAYWRIGHT_MAX_PORT;
const MAX_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours idle → eligible for eviction

interface PlaywrightInstance {
  process: ChildProcess;
  port: number;
  userId: string;
  startedAt: number;
  lastUsedAt: number;
}

const instances = new Map<string, PlaywrightInstance>();

// Track used ports to avoid collisions
const usedPorts = new Set<number>();

// Prevent concurrent spawns for the same key
const spawning = new Map<string, Promise<number | null>>();

// --- Health fail notification callback ---
type PlaywrightFailHandler = (instanceKey: string, userId: string) => void;
let _onPlaywrightFail: PlaywrightFailHandler | null = null;
export function onPlaywrightHealthFail(handler: PlaywrightFailHandler) {
  _onPlaywrightFail = handler;
}

/**
 * Evict the oldest idle instance to free a port.
 * Returns true if an instance was evicted.
 */
function evictIdleInstance(): boolean {
  let oldest: { key: string; lastUsedAt: number } | null = null;
  const now = Date.now();
  for (const [key, inst] of instances) {
    if (now - inst.lastUsedAt < MAX_IDLE_MS) continue;
    if (!oldest || inst.lastUsedAt < oldest.lastUsedAt) {
      oldest = { key, lastUsedAt: inst.lastUsedAt };
    }
  }
  if (oldest) {
    const idleMin = ((now - oldest.lastUsedAt) / 60000).toFixed(0);
    logger.info({ key: oldest.key, idleMin }, "Evicting idle playwright instance");
    killInstance(oldest.key);
    return true;
  }
  return false;
}

/**
 * Find an available port, killing zombie processes if needed.
 * If all ports are taken, evicts the oldest idle instance.
 */
async function allocatePort(): Promise<number> {
  for (let port = BASE_PORT; port <= MAX_PORT; port++) {
    if (usedPorts.has(port)) continue;
    usedPorts.add(port); // Reserve immediately before any await to prevent concurrent allocation

    // Check if something else is already on this port (zombie from previous run)
    if (isPortInUse(port)) {
      logger.warn({ port }, "Port occupied by external process, attempting cleanup");
      await killPlaywrightOnPort(port);
      if (isPortInUse(port)) {
        usedPorts.delete(port); // Still occupied — release reservation and try next
        continue;
      }
    }

    return port;
  }

  // All ports used — try evicting an idle instance
  if (evictIdleInstance()) {
    // Retry once after eviction
    for (let port = BASE_PORT; port <= MAX_PORT; port++) {
      if (usedPorts.has(port)) continue;
      usedPorts.add(port);
      return port;
    }
  }

  throw new Error(
    `No available ports for Playwright MCP (${instances.size} active instances, range ${BASE_PORT}-${MAX_PORT})`,
  );
}

function releasePort(port: number) {
  usedPorts.delete(port);
}

function isPortInUse(port: number): boolean {
  try {
    execFileSync("lsof", ["-i", `:${port}`, "-t"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function killPlaywrightOnPort(port: number) {
  try {
    // Only kill playwright-mcp processes on this port, not arbitrary services
    const pids = execFileSync("lsof", ["-i", `:${port}`, "-t"], { stdio: "pipe" })
      .toString()
      .trim();
    if (!pids) return;
    for (const pid of pids.split("\n")) {
      try {
        const cmdline = execFileSync("ps", ["-p", pid, "-o", "command="], { stdio: "pipe" })
          .toString()
          .trim();
        if (cmdline.includes("playwright-mcp")) {
          const pidNum = parseInt(pid, 10);
          if (!Number.isNaN(pidNum)) process.kill(pidNum, "SIGKILL");
          logger.info({ pid, port }, "Killed zombie playwright-mcp");
        } else {
          logger.warn(
            { port, pid, cmdline: cmdline.slice(0, 80) },
            "Port occupied by non-playwright process, skipping",
          );
        }
      } catch (e) {
        logger.warn({ err: e, port }, "Failed to inspect process occupying port");
      }
    }
  } catch (e) {
    logger.warn({ err: e, port }, "Failed to check processes on port");
  }
  // Wait for port to actually be released
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (!isPortInUse(port)) return;
    await delay(200);
  }
}

/**
 * Kill all leftover playwright-mcp processes from previous bot runs.
 * Call once at bot startup.
 */
export function cleanupZombiePlaywright(): void {
  try {
    const pids = execFileSync("pgrep", ["-f", "playwright-mcp"], { stdio: "pipe" })
      .toString()
      .trim();
    if (pids) {
      logger.info(
        { pids: pids.replace(/\n/g, ", ") },
        "Cleaning up zombie playwright-mcp processes",
      );
      for (const pid of pids.split("\n")) {
        const pidNum = parseInt(pid.trim(), 10);
        if (!Number.isNaN(pidNum)) {
          try {
            process.kill(pidNum, "SIGKILL");
          } catch (e) {
            logger.warn({ err: e, pid: pidNum }, "Failed to kill leftover playwright process");
          }
        }
      }
    }
  } catch {
    // No processes found — good
  }
}

/**
 * Health check — can we reach the SSE endpoint?
 */
async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/sse`, {
      signal: AbortSignal.timeout(2000),
    });
    res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Clean up Chrome Singleton files (SingletonLock, SingletonSocket, SingletonCookie)
 * in a user data directory. These stale files prevent browser relaunch after crash.
 */
function cleanSingletonFiles(userDataDir: string): void {
  try {
    const files = readdirSync(userDataDir);
    for (const f of files) {
      if (f.startsWith("Singleton")) {
        try {
          unlinkSync(resolve(userDataDir, f));
          logger.info({ file: f, userDataDir }, "Removed stale Singleton file");
        } catch (e) {
          logger.warn({ err: e, file: f }, "Failed to remove stale Chrome Singleton file");
        }
      }
    }
  } catch {
    // Directory may not exist
  }
}

/**
 * Kill Chrome child processes spawned by a Playwright MCP instance.
 */
function killChromeChildren(pid: number): void {
  try {
    // Find child Chrome processes of this playwright-mcp
    const children = execFileSync("pgrep", ["-P", String(pid)], { stdio: "pipe" })
      .toString()
      .trim();
    if (!children) return;
    for (const cpid of children.split("\n")) {
      try {
        const pidNum = parseInt(cpid, 10);
        if (!Number.isNaN(pidNum)) process.kill(pidNum, "SIGKILL");
      } catch (e) {
        logger.warn({ err: e, pid: cpid }, "Failed to kill Chrome child process");
      }
    }
    logger.info({ parentPid: pid }, "Killed Chrome child processes");
  } catch {
    // No children found — fine
  }
}

/**
 * Resolve the userDataDir for an instanceKey. Phase-2: forum topics get a
 * group-prefixed subdir so group A's "research" and group B's "research"
 * never share a Chrome profile (cookies, storage). Examples:
 *   "123"               → /…/user_123/default
 *   "123::주식"          → /…/user_123/주식                       (legacy / DM)
 *   "123:42:주식"        → /…/user_123/42_주식
 */
function resolveUserDataDir(instanceKey: string): string {
  const { userId, groupId, topic } = parseInstanceKey(instanceKey);
  const subDir = topic ? sanitizeTopicName(topic) : "default";
  const prefixed = groupId !== undefined ? `${groupId}_${subDir}` : subDir;
  return resolve(PLAYWRIGHT_PROFILES_DIR, `user_${userId}/${prefixed}`);
}

/**
 * Kill and clean up a specific instance.
 * Also kills Chrome child processes and cleans up Singleton files.
 * @param keepPort - If true, don't release the port (for same-port respawn).
 */
function killInstance(instanceKey: string, opts?: { keepPort?: boolean }) {
  const inst = instances.get(instanceKey);
  if (!inst) return;

  // Kill Chrome children first (before killing the MCP server)
  if (inst.process.pid) {
    killChromeChildren(inst.process.pid);
  }

  try {
    inst.process.kill("SIGTERM");
  } catch (e) {
    logger.warn({ err: e, instanceKey }, "Failed to kill playwright instance");
  }

  // Drop the spawn-time error/exit handlers. Cleanup is done synchronously
  // here, so the late-firing listeners only add duplicate instances.delete()
  // calls and keep the process reference alive until exit. Removing them
  // also lets callers (e.g. killAllPlaywright) attach their own exit waiter
  // without the spawn handler racing against it.
  inst.process.removeAllListeners("error");
  inst.process.removeAllListeners("exit");

  cleanSingletonFiles(resolveUserDataDir(instanceKey));

  if (!opts?.keepPort) releasePort(inst.port);
  instances.delete(instanceKey);
  deletePortFile(instanceKey);
  logger.info(
    { instanceKey, port: inst.port, keepPort: !!opts?.keepPort },
    "Killed Playwright MCP (with cleanup)",
  );
}

/**
 * Spawn a new Playwright MCP SSE server for a specific session. The
 * (user, group, topic) triple is encoded in `instanceKey` and decoded inside
 * `resolveUserDataDir` — no separate topic argument needed.
 */
async function spawnPlaywright(instanceKey: string, userId: string): Promise<number> {
  const port = await allocatePort();
  const userDataDir = resolveUserDataDir(instanceKey);
  mkdirSync(userDataDir, { recursive: true });

  const proc = spawn(
    PLAYWRIGHT_MCP_BIN,
    [
      "--port",
      String(port),
      "--user-data-dir",
      userDataDir,
      "--shared-browser-context",
      "--browser",
      "chrome",
      "--init-script",
      STEALTH_SCRIPT,
    ],
    {
      stdio: "ignore",
      detached: false,
    },
  );

  proc.once("error", (err) => {
    logger.error({ err, instanceKey }, "Playwright MCP error");
    if (instances.get(instanceKey)?.process === proc) {
      releasePort(port);
      instances.delete(instanceKey);
    }
  });

  proc.once("exit", (code) => {
    logger.info({ instanceKey, code }, "Playwright MCP exited");
    if (instances.get(instanceKey)?.process === proc) {
      releasePort(port);
      instances.delete(instanceKey);
    }
  });

  const now = Date.now();
  instances.set(instanceKey, {
    process: proc,
    port,
    userId,
    startedAt: now,
    lastUsedAt: now,
  });

  const ready = await waitForServer(port, 10_000);
  if (!ready && _onPlaywrightFail) {
    _onPlaywrightFail(instanceKey, userId);
  }
  writePortFile(instanceKey, port);
  logger.info({ instanceKey, port, pid: proc.pid, ready }, "Playwright MCP started");
  return port;
}

/**
 * Ensure a healthy Playwright MCP SSE server is running for this session.
 * Each (user, group, topic) triple gets its own browser process with isolated
 * data dir — Phase-2 multi-group requires group-level isolation so the same
 * topic name in two groups doesn't share a Chrome profile.
 * - If running and healthy → reuse
 * - If running but unhealthy → kill and respawn
 * - If not running → spawn
 */
export async function ensurePlaywright(
  userId: string,
  topic?: string,
  groupId?: number,
): Promise<number> {
  const instanceKey = makeInstanceKey(userId, groupId, topic);

  // If a spawn/restart is already in progress for this key, wait for it
  const inProgress = spawning.get(instanceKey);
  if (inProgress) {
    const port = await inProgress;
    if (port !== null) return port;
    // Restart failed — fall through to spawn fresh
  }

  const existing = instances.get(instanceKey);

  if (existing && !existing.process.killed && existing.process.exitCode === null) {
    if (await isHealthy(existing.port)) {
      existing.lastUsedAt = Date.now();
      return existing.port;
    }
    logger.warn({ instanceKey }, "Playwright MCP unresponsive, restarting");
    killInstance(instanceKey);
  } else if (existing) {
    releasePort(existing.port);
    instances.delete(instanceKey);
  }

  const promise = spawnPlaywright(instanceKey, userId).finally(() => spawning.delete(instanceKey));
  spawning.set(instanceKey, promise);
  return promise;
}

/**
 * Poll until the SSE server responds, or timeout.
 * Returns true if the server is healthy, false on timeout.
 */
async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isHealthy(port)) return true;
    await delay(300);
  }
  logger.warn({ port, timeoutMs }, "Playwright MCP not ready, proceeding anyway");
  return false;
}

/**
 * Kill all Playwright MCP instances for a specific user.
 */
export function killPlaywrightForUser(userId: string): void {
  for (const key of [...instances.keys()]) {
    if (key === userId || key.startsWith(`${userId}:`)) {
      killInstance(key);
    }
  }
}

/**
 * Force-restart Playwright for a user+topic.
 * Kills the existing instance (with Chrome cleanup + Singleton removal)
 * and immediately respawns on the SAME port so the next query gets a
 * fresh browser without waiting for the idle-eviction cycle.
 * Returns the new port, or null if no instance was running.
 */
export async function restartPlaywright(
  userId: string,
  topic?: string,
  groupId?: number,
): Promise<number | null> {
  const instanceKey = makeInstanceKey(userId, groupId, topic);

  // If a spawn is already in progress, wait for it instead of double-spawning
  const inProgress = spawning.get(instanceKey);
  if (inProgress) return inProgress;

  const inst = instances.get(instanceKey);
  if (!inst) return null;

  const oldPort = inst.port;
  logger.info({ instanceKey, oldPort }, "Force-restarting Playwright MCP (browser crash recovery)");

  const promise = (async (): Promise<number | null> => {
    // Kill but keep port reserved — we'll reuse it for respawn
    killInstance(instanceKey, { keepPort: true });

    // Wait for old process to release the port
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (!isPortInUse(oldPort)) break;
      await delay(200);
    }

    // Re-clean Singleton files after process is fully dead —
    // graceful SIGTERM shutdown may have re-created them.
    const userDataDir = resolveUserDataDir(instanceKey);
    cleanSingletonFiles(userDataDir);

    // Respawn on the same port
    try {
      mkdirSync(userDataDir, { recursive: true });
      const proc = spawn(
        PLAYWRIGHT_MCP_BIN,
        [
          "--port",
          String(oldPort),
          "--user-data-dir",
          userDataDir,
          "--shared-browser-context",
          "--browser",
          "chrome",
          "--init-script",
          STEALTH_SCRIPT,
        ],
        {
          stdio: "ignore",
          detached: false,
        },
      );

      proc.once("error", (err) => {
        logger.error({ err, instanceKey }, "Playwright MCP error (respawn)");
        if (instances.get(instanceKey)?.process === proc) {
          releasePort(oldPort);
          instances.delete(instanceKey);
        }
      });

      proc.once("exit", (code) => {
        logger.info({ instanceKey, code }, "Playwright MCP exited (respawn)");
        if (instances.get(instanceKey)?.process === proc) {
          releasePort(oldPort);
          instances.delete(instanceKey);
        }
      });

      const now = Date.now();
      instances.set(instanceKey, {
        process: proc,
        port: oldPort,
        userId,
        startedAt: now,
        lastUsedAt: now,
      });

      const ready = await waitForServer(oldPort, 10_000);
      writePortFile(instanceKey, oldPort);
      logger.info(
        { instanceKey, port: oldPort, pid: proc.pid, ready },
        "Playwright MCP respawned (same port)",
      );
      return oldPort;
    } catch (e) {
      logger.error({ err: e, instanceKey }, "Failed to respawn Playwright MCP");
      releasePort(oldPort);
      return null;
    }
  })().finally(() => spawning.delete(instanceKey));

  spawning.set(instanceKey, promise);
  return promise;
}

/**
 * Kill a specific topic's Playwright instance.
 * Browser data directory is preserved so that recreating a topic with the same name
 * (in the same group) reuses the same Chrome profile — login state (cookies)
 * persists across topic restarts.
 */
export function killPlaywrightForTopic(userId: string, topic: string, groupId?: number): void {
  killInstance(makeInstanceKey(userId, groupId, topic));
}

/**
 * Resolve the on-disk Playwright user-data-dir for a (user, group, topic) triple.
 * Useful for external callers that need to inspect / copy / delete the dir without
 * touching the running process.
 */
export function resolveTopicProfileDir(userId: string, topic: string, groupId?: number): string {
  return resolveUserDataDir(makeInstanceKey(userId, groupId, topic));
}

export interface CloneProfileResult {
  copied: boolean;
  srcDir: string;
  dstDir: string;
  /** Set when `copied=false` to explain why (e.g. src-missing, same-dir, copy-failed:…) */
  reason?: string;
}

/**
 * Clone a parent topic's Playwright profile to a fresh child topic so that
 * cookies / localStorage / login state are inherited. Used by /fork and /spawn.
 *
 * Safety: if the parent instance is currently running, we kill it first to flush
 * SQLite WAL state to disk, then copy. The parent is NOT respawned here — the
 * next user message on the parent topic will trigger ensurePlaywright() to bring
 * it back. This avoids a race where copy and live writes interleave.
 *
 * Copy strategy:
 *   - macOS APFS: `cp -cR` triggers clonefile() (metadata-only, ms-level).
 *   - Other CoW filesystems: same flag uses native CoW if supported.
 *   - Fallback: regular full copy (still correct, just slower).
 */
export async function cloneProfileForChild(opts: {
  userId: string;
  groupId?: number;
  srcTopic: string;
  dstTopic: string;
}): Promise<CloneProfileResult> {
  const srcKey = makeInstanceKey(opts.userId, opts.groupId, opts.srcTopic);
  const dstKey = makeInstanceKey(opts.userId, opts.groupId, opts.dstTopic);
  const srcDir = resolveUserDataDir(srcKey);
  const dstDir = resolveUserDataDir(dstKey);

  if (srcDir === dstDir) {
    return { copied: false, srcDir, dstDir, reason: "same-dir" };
  }

  // Quiesce parent if running so Chrome flushes SQLite (Cookies, Login Data)
  // before we read the bytes. Without this, an in-flight COMMIT could leave the
  // clone with a torn WAL and the child would start logged-out.
  //
  // killInstance() sends SIGTERM and removes the instance map entry synchronously,
  // but Chrome's subprocess exit + on-disk flush is async. Empirically 1.0–1.5s
  // is enough for the cookie store to settle; we wait 1.5s to be safe.
  const parentWasLive = instances.has(srcKey);
  if (parentWasLive) {
    logger.info({ srcKey }, "Quiescing parent Playwright before profile clone");
    killInstance(srcKey);
    await delay(1500);
  }

  // Defensive: dst should be brand-new but kill any stray instance just in case
  if (instances.has(dstKey)) {
    killInstance(dstKey);
    await delay(500);
  }

  if (!existsSync(srcDir)) {
    return { copied: false, srcDir, dstDir, reason: "src-missing" };
  }

  try {
    if (existsSync(dstDir)) {
      rmSync(dstDir, { recursive: true, force: true });
    }
    mkdirSync(dirname(dstDir), { recursive: true });
    // `-c` requests clonefile() on APFS; harmless no-op elsewhere.
    execFileSync("cp", ["-cR", srcDir, dstDir], { stdio: "pipe" });
  } catch (e) {
    const reason = `copy-failed: ${e instanceof Error ? e.message : String(e)}`;
    logger.warn({ srcDir, dstDir, err: e }, "Playwright profile clone failed");
    return { copied: false, srcDir, dstDir, reason };
  }

  // Strip per-process locks copied from the parent so the child Chrome can
  // launch on its fresh dir without a fake "another instance is running" error.
  cleanSingletonFiles(dstDir);
  for (const f of ["DevToolsActivePort", "LOCK"]) {
    try {
      unlinkSync(resolve(dstDir, f));
    } catch {
      // Not all profiles have these — ignore.
    }
  }

  logger.info({ srcKey, dstKey, srcDir, dstDir }, "Cloned Playwright profile for child topic");
  return { copied: true, srcDir, dstDir };
}

/**
 * Kill the topic's Playwright instance and remove its user-data-dir from disk.
 * Use for fork-topic deletion where the profile is a copy of the parent and
 * shouldn't linger after the fork is gone. Regular topic deletion should call
 * `killPlaywrightForTopic` instead so login state survives a topic recreation.
 */
export function deleteTopicProfileDir(
  userId: string,
  topic: string,
  groupId?: number,
): { deleted: boolean; dir: string } {
  const key = makeInstanceKey(userId, groupId, topic);
  if (instances.has(key)) killInstance(key);
  const dir = resolveUserDataDir(key);
  if (!existsSync(dir)) return { deleted: false, dir };
  try {
    rmSync(dir, { recursive: true, force: true });
    logger.info(
      { dir, userId, topic, groupId },
      "Deleted topic Playwright profile dir (fork cleanup)",
    );
    return { deleted: true, dir };
  } catch (e) {
    logger.warn(
      { err: e, dir, userId, topic, groupId },
      "Failed to delete topic Playwright profile dir",
    );
    return { deleted: false, dir };
  }
}

/**
 * Kill all running Playwright MCP instances and wait for them to exit.
 * Call on bot shutdown. Waits up to 3s per instance before giving up.
 */
export async function killAllPlaywright(): Promise<void> {
  const procs = [...instances.entries()].map(([key, inst]) => ({ key, proc: inst.process }));
  for (const { key } of procs) killInstance(key);

  const deadline = Date.now() + 3000;
  const waits = procs.map(
    ({ proc }) =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.killed) {
          resolve();
          return;
        }
        proc.once("exit", () => resolve());
        proc.once("error", () => resolve());
        // Fallback: don't block shutdown forever
        const t = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        if (typeof t === "object") t.unref?.();
      }),
  );
  await Promise.all(waits);
}

// Proactively evict all idle instances every 30 minutes
setInterval(
  () => {
    while (evictIdleInstance()) {}
  },
  30 * 60 * 1000,
).unref();
