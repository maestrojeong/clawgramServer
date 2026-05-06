/**
 * 다른 서버의 sessions.db에서 유저/토픽 데이터를 현재 DB에 머지
 * 실행: bun run scripts/merge-users.ts <source_db_path>
 *
 * 예시: bun run scripts/merge-users.ts export_users_20260331/logs/sessions.db
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";

const sourceDbPath = process.argv[2];
if (!sourceDbPath) {
  console.error("Usage: bun run scripts/merge-users.ts <source_db_path>");
  process.exit(1);
}
if (!existsSync(sourceDbPath)) {
  console.error(`Not found: ${sourceDbPath}`);
  process.exit(1);
}

const TARGET_DB = join(process.cwd(), "logs/sessions.db");
const db = new Database(TARGET_DB, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = OFF");

// 소스 DB attach
db.exec(`ATTACH DATABASE '${sourceDbPath.replace(/'/g, "''")}' AS src`);

// 소스 유저 목록 확인
const srcUsers = db.query<{ id: string; forum_group_title: string | null }, []>(
  "SELECT id, forum_group_title FROM src.users"
).all();

if (srcUsers.length === 0) {
  console.log("소스 DB에 유저가 없습니다.");
  process.exit(0);
}

console.log(`머지할 유저 ${srcUsers.length}명:`);
for (const u of srcUsers) {
  console.log(`  - ${u.id} (${u.forum_group_title ?? "그룹 없음"})`);
}

// 머지 (upsert)
const merge = db.transaction(() => {
  const userResult = db.exec("INSERT OR REPLACE INTO main.users SELECT * FROM src.users");
  const topicResult = db.exec("INSERT OR REPLACE INTO main.topics SELECT * FROM src.topics");
});

merge();

db.exec("DETACH DATABASE src");
db.exec("PRAGMA foreign_keys = ON");

// 검증
for (const u of srcUsers) {
  const row = db.query<{ topics: number }, string>(
    "SELECT COUNT(*) as topics FROM topics WHERE user_id = ?"
  ).get(u.id);
  console.log(`✅ ${u.id} (${u.forum_group_title}): ${row?.topics ?? 0}개 토픽`);
}

console.log("\n머지 완료. 봇을 재시작하세요: pm2 restart clawgramServer");
