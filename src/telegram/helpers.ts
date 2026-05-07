import TelegramBot from "node-telegram-bot-api";
import { bot } from "@/telegram/client";
import { promises as fsPromises } from "fs";
import { logger } from "@/core/logger";

interface TelegramApiError {
  response?: {
    statusCode?: number;
    body?: { parameters?: { retry_after?: number } };
  };
  code?: string;
}

// --- Retry wrapper for Telegram API calls ---
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as TelegramApiError;
      const statusCode = e?.response?.statusCode;
      const isRetryable = statusCode === 504 || statusCode === 502 || statusCode === 429 ||
        e?.code === "ETIMEDOUT" || e?.code === "ECONNRESET";

      if (!isRetryable || attempt === maxRetries - 1) throw err;

      const delay = statusCode === 429
        ? (Number(e?.response?.body?.parameters?.retry_after) || 5) * 1000
        : 1000 * (attempt + 1);
      logger.warn({ attempt: attempt + 1, maxRetries, status: statusCode || e?.code, delay }, "Telegram API retry");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

/** Send message with retry */
export async function sendMsg(chatId: number, text: string, opts?: TelegramBot.SendMessageOptions) {
  return withRetry(() => bot.sendMessage(chatId, text, opts));
}

/** Send photo with retry */
export async function sendPhoto(chatId: number, photo: Buffer, opts?: TelegramBot.SendPhotoOptions, fileOpts?: TelegramBot.FileOptions) {
  return withRetry(() => bot.sendPhoto(chatId, photo, opts, fileOpts));
}

/** Send document with retry */
export async function sendDoc(chatId: number, doc: Buffer, opts?: TelegramBot.SendDocumentOptions, fileOpts?: TelegramBot.FileOptions) {
  return withRetry(() => bot.sendDocument(chatId, doc, opts, fileOpts));
}

/** Send a long message in chunks, awaiting each to preserve order */
export async function sendSplitMsg(chatId: number, text: string, opts?: TelegramBot.SendMessageOptions): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await sendMsg(chatId, chunk, opts);
  }
}

/** Split message into chunks of max 4096 chars */
export function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at newline
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    const atNewline = splitAt >= maxLen / 2;
    if (!atNewline) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    // If we split at a newline, skip it so the next chunk doesn't start with \n
    remaining = remaining.slice(atNewline ? splitAt + 1 : splitAt);
  }
  return chunks;
}

/** Image file extensions */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];

/** Telegram Bot API upload limits */
const MAX_PHOTO_SIZE = 10 * 1024 * 1024;  // 10MB for photos
const MAX_DOC_SIZE = 50 * 1024 * 1024;    // 50MB for documents

/** Send a local file as photo (if image) or document to a chat.
 *  Returns the Telegram message_id of the sent file, or null if a fallback text was sent
 *  (file too large to upload as document). */
export async function sendFileToChat(
  chatId: number,
  filePath: string,
  threadOpts?: TelegramBot.SendMessageOptions,
): Promise<{ messageId: number } | null> {
  const fileStat = await fsPromises.stat(filePath);
  const fileName = filePath.split("/").pop() || "file";
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const isImage = IMAGE_EXTS.includes(ext);
  const maxSize = isImage ? MAX_PHOTO_SIZE : MAX_DOC_SIZE;

  if (fileStat.size > maxSize) {
    // 이미지가 10MB 초과시 문서로 전송 시도
    if (isImage && fileStat.size <= MAX_DOC_SIZE) {
      const fileBuffer = await fsPromises.readFile(filePath);
      const m = await sendDoc(chatId, fileBuffer, threadOpts as TelegramBot.SendDocumentOptions, { filename: fileName, contentType: "application/octet-stream" });
      return { messageId: m.message_id };
    }
    await sendMsg(chatId, `파일이 너무 큽니다 (${(fileStat.size / 1024 / 1024).toFixed(1)}MB, 최대 ${maxSize / 1024 / 1024}MB): ${fileName}`, threadOpts);
    return null;
  }

  const fileBuffer = await fsPromises.readFile(filePath);
  const m = isImage
    ? await sendPhoto(chatId, fileBuffer, threadOpts as TelegramBot.SendPhotoOptions, { filename: fileName, contentType: `image/${ext === "jpg" ? "jpeg" : ext}` })
    : await sendDoc(chatId, fileBuffer, threadOpts as TelegramBot.SendDocumentOptions, { filename: fileName, contentType: "application/octet-stream" });
  return { messageId: m.message_id };
}

// --- Markdown → Telegram HTML conversion ---

/** Escape HTML entities */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert Markdown to Telegram-compatible HTML.
 * Handles: code blocks, inline code, bold, italic, strikethrough, links, headings, blockquotes.
 */
export function markdownToTelegramHtml(md: string): string {
  // 1. Extract code blocks first to protect their content
  const codeBlocks: string[] = [];
  let text = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    const tag = lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`;
    codeBlocks.push(tag);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${inlineCodes.length - 1}\x00`;
  });

  // 3. Escape HTML in remaining text
  text = escapeHtml(text);

  // 4. Headings → bold (### before ## before #)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // 5. Bold + italic (***text***)
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");

  // 6. Bold (**text**)
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 7. Italic (*text*) — avoid matching inside words like file_*name*
  text = text.replace(/(?<!\w)\*([^\s*](?:.*?[^\s*])?)\*(?!\w)/g, "<i>$1</i>");

  // 8. Strikethrough (~~text~~)
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 9. Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 10. Blockquotes (> lines → <blockquote>)
  text = text.replace(/(?:^&gt; .+\n?)+/gm, (block) => {
    const content = block.replace(/^&gt; /gm, "").trim();
    return `<blockquote>${content}</blockquote>`;
  });

  // 11. Restore inline code
  text = text.replace(/\x00INLINE(\d+)\x00/g, (_m, i) => inlineCodes[Number(i)]);

  // 12. Restore code blocks
  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, i) => codeBlocks[Number(i)]);

  return text;
}

/**
 * Send message as HTML, falling back to plain text if Telegram rejects the HTML.
 */
export async function sendHtmlMsg(chatId: number, text: string, opts?: TelegramBot.SendMessageOptions) {
  const html = markdownToTelegramHtml(text);
  try {
    return await withRetry(() => bot.sendMessage(chatId, html, { ...opts, parse_mode: "HTML" }));
  } catch (err) {
    // If Telegram rejects the HTML (400 Bad Request), fall back to plain text
    const statusCode = (err as TelegramApiError)?.response?.statusCode;
    if (statusCode === 400) {
      return await sendMsg(chatId, text, opts);
    }
    throw err;
  }
}

/** Handle Telegram file download error and send localized message */
export async function handleDownloadError(chatId: number, err: unknown, mediaType: string, threadId?: number): Promise<void> {
  const errMsg = err instanceof Error ? err.message : "unknown";
  const opts = threadId ? { message_thread_id: threadId } : {};
  if (errMsg.includes("file is too big")) {
    await sendMsg(chatId, `${mediaType}이(가) 너무 커서 다운로드할 수 없습니다. Telegram Bot API 파일 크기 제한을 초과했습니다.`, opts);
  } else {
    await sendMsg(chatId, `${mediaType} 다운로드 실패: ${errMsg}`, opts);
  }
}
