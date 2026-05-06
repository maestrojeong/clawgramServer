export function errMsg(e: unknown, fallback?: string): string {
  if (e instanceof Error) return e.message;
  return fallback ?? String(e);
}
