/** Shared MCP tool response helpers — reduce boilerplate for the common text response shape. */

type McpContent = { type: "text"; text: string };
type McpResponse = { content: McpContent[] };
type McpErrorResponse = { content: McpContent[]; isError: true };

export function mcpOk(text: string): McpResponse {
  return { content: [{ type: "text", text }] };
}

export function mcpError(text: string): McpErrorResponse {
  return { content: [{ type: "text", text }], isError: true };
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
