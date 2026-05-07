#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { stat, realpath } from "fs/promises";
import { basename, extname, resolve } from "path";
import { homedir } from "os";

const ALLOWED_DIR = homedir();

async function isAllowed(filePath: string): Promise<boolean> {
  const normalized = resolve(filePath);
  if (!normalized.startsWith(ALLOWED_DIR + "/") && normalized !== ALLOWED_DIR) {
    return false;
  }
  // Resolve symlinks to prevent traversal attacks
  try {
    const real = await realpath(normalized);
    return real.startsWith(ALLOWED_DIR + "/") || real === ALLOWED_DIR;
  } catch {
    return false;
  }
}

const server = new McpServer({
  name: "send-file",
  version: "1.0.0",
});

server.tool(
  "send_file",
  "Send a local file to the user in the chat. Use this when you want to share a file (image, document, PDF, code, etc.) with the user. The file will appear as a downloadable item in the chat.",
  { file_path: z.string().describe("Absolute path to the file to send") },
  async ({ file_path }) => {
    if (!await isAllowed(file_path)) {
      return {
        content: [{ type: "text", text: `Error: Access denied. Files must be within ${ALLOWED_DIR}` }],
        isError: true,
      };
    }
    try {
      const stats = await stat(resolve(file_path));
      if (!stats.isFile()) {
        return {
          content: [{ type: "text", text: `Error: ${file_path} is not a file` }],
          isError: true,
        };
      }

      const name = basename(file_path);
      const ext = extname(file_path).toLowerCase();
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

      return {
        content: [
          {
            type: "text",
            text: `✅ File sent to chat: ${name} (${ext}, ${sizeMB}MB)\nPath: ${file_path}`,
          },
        ],
      };
    } catch {
      return {
        content: [{ type: "text", text: `Error: File not found at ${file_path}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "send_files",
  "Send multiple local files to the user in the chat at once.",
  { file_paths: z.array(z.string()).describe("Array of absolute file paths to send") },
  async ({ file_paths }) => {
    const results: string[] = [];
    for (const file_path of file_paths) {
      if (!await isAllowed(file_path)) {
        results.push(`❌ ${file_path}: access denied (outside workspace)`);
        continue;
      }
      try {
        const stats = await stat(resolve(file_path));
        if (!stats.isFile()) {
          results.push(`❌ ${file_path}: not a file`);
          continue;
        }
        const name = basename(file_path);
        const ext = extname(file_path).toLowerCase();
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        results.push(`✅ ${name} (${ext}, ${sizeMB}MB) — ${file_path}`);
      } catch {
        results.push(`❌ ${file_path}: not found`);
      }
    }
    return {
      content: [{ type: "text", text: `Files sent to chat:\n${results.join("\n")}` }],
    };
  }
);

const HTML_PAGE_SERVER = process.env.HTML_PAGE_SERVER;

if (HTML_PAGE_SERVER) {
  server.tool(
    "send_html",
    "Publish an HTML string as a temporary web page and return the public URL. Use this when you want to share rich HTML content (tables, charts, styled reports, etc.) with the user as a viewable page.",
    { html: z.string().describe("HTML content to publish as a web page") },
    async ({ html }) => {
      try {
        const res = await fetch(`${HTML_PAGE_SERVER}/pages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ html }),
        });
        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Error: server returned ${res.status}` }],
            isError: true,
          };
        }
        const data = await res.json() as { uuid: string; url: string; expires_at: number };
        const expiresDate = new Date(data.expires_at * 1000).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
        return {
          content: [
            {
              type: "text",
              text: `✅ HTML 페이지가 생성됐어요!\n🔗 URL: ${data.url}\n⏰ 만료: ${expiresDate}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${e}` }],
          isError: true,
        };
      }
    }
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
