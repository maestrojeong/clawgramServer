import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function parseJsonlText<T = unknown>(raw: string): T[] {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function writeJsonlFile(filePath: string, entries: readonly unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

export function appendJsonlEntry(filePath: string, entry: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}
