export function formatToolUse(name: string, input: Record<string, unknown>): string {
  let detail = "";
  if (input.command) detail = String(input.command);
  else if (input.file_path || input.path) detail = String(input.file_path || input.path);
  else if (input.url) detail = String(input.url);
  else if (input.pattern) detail = String(input.pattern);
  else if (input.query || input.text) detail = String(input.query || input.text);
  else if (input.task) detail = String(input.task);
  else if (input.to) detail = String(input.to);
  else if (input.message) detail = String(input.message).slice(0, 80);
  else if (input.content) detail = String(input.content).slice(0, 80);

  if (detail) {
    return `${name}(${detail.length > 100 ? `${detail.slice(0, 100)}...` : detail})`;
  }
  return name;
}
