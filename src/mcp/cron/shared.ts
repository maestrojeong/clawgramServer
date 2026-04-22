/**
 * Shared helpers for cron MCP servers (manager + dm) and the runner.
 * No MCP-specific logic — pure data access + pure functions.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_NAME, SESSIONS_DB } from "@/core/config";

/**
 * Seconds after which a cron lock (session or job) is considered stale.
 * Also used as the "session is alive" threshold for Claude session files.
 */
export const SESSION_STALE_SEC = 1800;

export interface CronMeta {
  topic: string;
  script: string;
  cron: string;
}

export function readMeta(metaDir: string, name: string): CronMeta | null {
  try {
    return JSON.parse(readFileSync(join(metaDir, `${name}.json`), "utf-8")) as CronMeta;
  } catch {
    return null;
  }
}

export function writeMeta(metaDir: string, name: string, meta: CronMeta): void {
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, `${name}.json`), JSON.stringify(meta));
}

export function deleteMeta(metaDir: string, name: string): void {
  try {
    unlinkSync(join(metaDir, `${name}.json`));
  } catch {}
}

export function readLockFile(file: string): {
  held: boolean;
  acquiredAt: string | null;
  stale: boolean;
} {
  if (!existsSync(file)) return { held: false, acquiredAt: null, stale: false };
  const ts = Number(readFileSync(file, "utf-8").trim());
  if (Number.isNaN(ts)) return { held: false, acquiredAt: null, stale: false };
  return {
    held: true,
    acquiredAt: new Date(ts * 1000).toISOString(),
    stale: Date.now() / 1000 - ts > SESSION_STALE_SEC,
  };
}

/** Topics are scoped by SERVER_NAME in this project (shared across users within a group). */
export function getServerTopics(): string[] {
  if (!existsSync(SESSIONS_DB)) return [];
  const db = new Database(SESSIONS_DB, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    return db
      .query<{ name: string }, string>("SELECT name FROM topics WHERE server_name = ?")
      .all(SERVER_NAME)
      .map((r) => r.name);
  } catch (e) {
    process.stderr.write(`warn: cron: failed to query topics: ${e}\n`);
    return [];
  } finally {
    db.close();
  }
}

// --- Cron expression validation & next-run computation ---

export function isValidCron(expr: string): { valid: boolean; error?: string } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return {
      valid: false,
      error: `Expected 5 fields (minute hour day month weekday), got ${fields.length}`,
    };
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
    for (const part of field.split(",")) {
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

export function matchCronField(field: string, value: number, min: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    const stepIdx = part.indexOf("/");
    const step = stepIdx !== -1 ? Number(part.slice(stepIdx + 1)) : 1;
    const base = stepIdx !== -1 ? part.slice(0, stepIdx) : part;
    if (base === "*") {
      if ((value - min) % step === 0) return true;
    } else if (base.includes("-")) {
      const [lo, hi] = base.split("-").map(Number);
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
    } else {
      const n = Number(base);
      if (n === value) return true;
      if (n === 7 && value === 0) return true; // Sunday: 0 or 7
    }
  }
  return false;
}

/**
 * Compute the next time a cron expression will match, starting from `from` (default: now).
 * Follows classic Vixie-cron semantics: when BOTH day-of-month and day-of-week are
 * restricted (not "*"), a match on EITHER field is sufficient.
 * Returns null if no match found within one year.
 */
export function computeNextRun(expr: string, from: Date = new Date()): string | null {
  try {
    const [minF, hourF, domF, monF, dowF] = expr.trim().split(/\s+/);
    const domRestricted = domF !== "*";
    const dowRestricted = dowF !== "*";
    const d = new Date(from);
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    for (let i = 0; i < 525_600; i++) {
      const domMatch = matchCronField(domF, d.getDate(), 1);
      const dowMatch = matchCronField(dowF, d.getDay(), 0);
      const dayMatch =
        domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
      if (
        matchCronField(monF, d.getMonth() + 1, 1) &&
        dayMatch &&
        matchCronField(hourF, d.getHours(), 0) &&
        matchCronField(minF, d.getMinutes(), 0)
      ) {
        return d.toISOString();
      }
      d.setMinutes(d.getMinutes() + 1);
    }
    return null;
  } catch {
    return null;
  }
}
