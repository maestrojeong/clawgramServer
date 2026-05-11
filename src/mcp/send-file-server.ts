#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { genRequestId, waitForResponse, writeCommand } from "@/mcp/dm-ipc";

const args = process.argv.slice(2);
const userId = args.find((a) => a.startsWith("--user-id="))?.split("=")[1] || "";
const topic = args.find((a) => a.startsWith("--topic="))?.split("=")[1] || "dm";
if (!userId) {
  process.stderr.write("FATAL: --user-id is required\n");
  process.exit(1);
}

type LocalFileInfo =
  | { ok: true; normalizedPath: string; name: string; ext: string; sizeMB: string }
  | { ok: false; error: string };

async function validateLocalFile(filePath: string): Promise<LocalFileInfo> {
  const normalizedPath = resolve(filePath);
  try {
    const stats = await stat(normalizedPath);
    if (!stats.isFile()) return { ok: false, error: `${filePath} is not a file` };
    return {
      ok: true,
      normalizedPath,
      name: basename(filePath),
      ext: extname(filePath).toLowerCase(),
      sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
    };
  } catch {
    return { ok: false, error: `File not found at ${filePath}` };
  }
}

function mcpOk(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function mcpError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

async function sendFileViaIpc(filePath: string) {
  const info = await validateLocalFile(filePath);
  if (!info.ok) return mcpError(`Error: ${info.error}`);

  const requestId = genRequestId();
  writeCommand(userId, {
    requestId,
    action: "send_file",
    params: { topic, file_path: info.normalizedPath },
    timestamp: new Date().toISOString(),
  });

  try {
    const resp = await waitForResponse(userId, requestId, 120_000);
    if (resp.success === false || typeof resp.error === "string") {
      return mcpError(`Error: ${resp.error || "File send failed"}`);
    }
    if (resp.success !== true || typeof resp.messageId !== "number") {
      return mcpError("Error: Invalid file send response from bot");
    }
    const messageId = resp.messageId;
    return mcpOk(
      [
        `File sent to chat: ${info.name} (${info.ext || "no extension"}, ${info.sizeMB}MB)`,
        `Path: ${info.normalizedPath}`,
        `Telegram message_id: ${messageId}`,
      ].join("\n"),
    );
  } catch (e) {
    return mcpError(
      `Error: ${e instanceof Error ? e.message : "Timeout waiting for bot response"}`,
    );
  }
}

const server = new McpServer({
  name: "send-file",
  version: "2.0.0",
});

server.tool(
  "send_file",
  "Send a local file to the user in the chat. Use this when you want to share a file (image, document, PDF, code, etc.) with the user. The file will appear as a downloadable item in the chat.",
  { file_path: z.string().describe("Absolute path to the file to send") },
  async ({ file_path }) => sendFileViaIpc(file_path),
);

server.tool(
  "send_files",
  "Send multiple local files to the user in the chat at once.",
  { file_paths: z.array(z.string()).describe("Array of absolute file paths to send") },
  async ({ file_paths }) => {
    const results: string[] = [];
    let hasError = false;
    for (const file_path of file_paths) {
      const response = await sendFileViaIpc(file_path);
      const text = response.content.map((c) => c.text).join("\n");
      if ("isError" in response && response.isError) {
        hasError = true;
        results.push(`ERROR ${file_path}: ${text.replace(/^Error: /, "")}`);
      } else {
        results.push(text);
      }
    }
    return {
      content: [{ type: "text" as const, text: `Files sent to chat:\n${results.join("\n\n")}` }],
      ...(hasError ? { isError: true as const } : {}),
    };
  },
);

const RELAY_SERVER_URL = process.env.RELAY_SERVER_URL;

if (RELAY_SERVER_URL) {
  server.tool(
    "send_html",
    "Publish an HTML string as a temporary web page and return the public URL. Use this when you want to share rich HTML content (tables, charts, styled reports, etc.) with the user as a viewable page.",
    { html: z.string().describe("HTML content to publish as a web page") },
    async ({ html }) => {
      try {
        const res = await fetch(`${RELAY_SERVER_URL}/pages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ html }),
        });
        if (!res.ok) return mcpError(`Error: server returned ${res.status}`);
        const data = await res.json() as { uuid: string; url: string; expires_at: number };
        const expiresDate = new Date(data.expires_at * 1000).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
        return mcpOk(`✅ HTML 페이지가 생성됐어요!\n🔗 URL: ${data.url}\n⏰ 만료: ${expiresDate}`);
      } catch (e) {
        return mcpError(`Error: ${e}`);
      }
    },
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
