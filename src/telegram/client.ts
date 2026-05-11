import TelegramBot from "node-telegram-bot-api";
import { logger } from "@/core/logger";
import { SERVER_NAME } from "@/core/config";
import { cleanupZombiePlaywright } from "@/core/playwright/manager";

// --- Config ---
export const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  logger.fatal("TELEGRAM_BOT_TOKEN not set. Add it to .env.local");
  process.exit(1);
}

if (!SERVER_NAME) {
  logger.fatal("SERVER_NAME not set. Add SERVER_NAME=<this-server-name> to .env (e.g. SERVER_NAME=mac1).");
  process.exit(1);
}

// --- Allowed users ---
export const ADMIN_USERS: Set<number> = new Set(
  (process.env.TELEGRAM_ADMIN_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
);

if (ADMIN_USERS.size === 0) {
  logger.warn("TELEGRAM_ADMIN_USERS not set. No one can use this bot.");
}

cleanupZombiePlaywright();

export const bot = new TelegramBot(TOKEN, { polling: true });

logger.info({ adminUsers: [...ADMIN_USERS], serverName: SERVER_NAME }, "Telegram bot started");
