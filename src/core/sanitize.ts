export function sanitizeTopicName(name: string, lowercase = false): string {
  const safe = name.replace(/[^a-zA-Z0-9가-힣_-]/g, "_") || "_";
  return lowercase ? safe.toLowerCase() : safe;
}
