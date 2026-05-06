/** Shared MCP tool response helpers — reduce boilerplate for the common text response shape. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

type McpContent = { type: "text"; text: string };
type McpResponse = { content: McpContent[] };
type McpErrorResponse = { content: McpContent[]; isError: true };

export function mcpOk(text: string): McpResponse {
  return { content: [{ type: "text", text }] };
}

export function mcpError(text: string): McpErrorResponse {
  return { content: [{ type: "text", text }], isError: true };
}

/** Wire up an McpServer to stdio and start the listener. Standard entrypoint for stdio-based MCP servers. */
export async function connectStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Parse the `--user-id=<N>` CLI flag from argv.
 * Rejects anything that isn't a positive integer — protects `user_${userId}` path joins
 * and `WHERE id = ?` binds if spawn args ever come from an untrusted source.
 * Returns empty string on missing/invalid values so callers can retain existing guards.
 */
export function parseUserIdArg(args: string[]): string {
  const raw = args.find((a) => a.startsWith("--user-id="))?.split("=")[1];
  if (!raw) return "";
  if (!/^[0-9]+$/.test(raw)) return "";
  return raw;
}

/**
 * Parse the `--group-id=<N>` CLI flag from argv. Forum group ids in Telegram
 * are negative (e.g. -1001234567890), so accept an optional leading "-".
 * Returns 0 on missing/invalid values; callers should treat 0 as "unscoped".
 */
export function parseGroupIdArg(args: string[]): number {
  const raw = args.find((a) => a.startsWith("--group-id="))?.split("=")[1];
  if (!raw) return 0;
  if (!/^-?[0-9]+$/.test(raw)) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
