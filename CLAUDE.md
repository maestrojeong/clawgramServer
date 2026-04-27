# Claude Code Telegram Bot

Telegram 포럼 기반 멀티세션 Claude AI 워크스페이스 봇.

> **개발 현황**: 현재 단 한 명의 사용자를 위해 운영 중이나, 다수 사용자를 지원할 수 있도록 설계하여 테스트 중인 단계.

## 프로젝트 구조

```
src/
├── core/                    # 핵심 비즈니스 로직 (Telegram 비의존)
│   ├── claude.ts            # claudeQuery() — Claude Agent SDK 래퍼, ClaudeEvent 스트림
│   ├── config.ts            # 경로, MCP 서버 설정, 시스템 프롬프트 로딩
│   ├── logger.ts            # pino 기반 구조화 로거 (전역 싱글턴)
│   ├── playwright-manager.ts # Playwright MCP SSE 프로세스 관리 (포트 할당, 헬스체크)
│   ├── pii-server-manager.ts # PII 서버 프로세스 관리 (spawn, 헬스체크, 재시작)
│   ├── pii-server.py        # Python FastAPI PII 탐지 서버 (NER + regex)
│   ├── pii-masker.ts        # PII 마스킹 로직 (서버 연동 + regex 폴백)
│   ├── korean-surnames.ts   # 한국어 성씨 데이터 (PII 탐지용)
│   ├── memory.ts            # 메모리 관리
│   ├── text-extractor.ts    # 텍스트 추출 유틸리티
│   ├── token-stats.ts       # 토큰 카운팅
│   ├── types.ts             # ClaudeEvent, ClaudeQueryOptions 타입
│   └── prompts/
│       ├── system.md        # 포럼 세션용 시스템 프롬프트
│       └── dm-system.md     # DM 세션용 시스템 프롬프트 (온보딩)
├── telegram/                # Telegram 봇 레이어
│   ├── bot.ts               # 엔트리포인트 — 이벤트 바인딩, 라우팅, cleanup
│   ├── client.ts            # TelegramBot 인스턴스, TOKEN, TELEGRAM_ADMIN_USERS
│   ├── helpers.ts           # withRetry, sendMsg/Photo/Doc, splitMessage, markdownToTelegramHtml, sendHtmlMsg, sendFileToChat
│   ├── logging.ts           # 활동 로그 JSONL 기록/조회, 로테이션 (파일 크기 기반)
│   ├── workspace.ts         # 사용자 워크스페이스 초기화, 디버그 토글, lock 파일
│   ├── attachments.ts       # 파일 다운로드, Whisper 음성인식(비동기), buildPromptFromMessage
│   ├── outbox.ts            # cron/DM/session IPC 폴링 (fs.watch + fallback interval)
│   ├── outbox-types.ts      # 콜백 등록 (ArchiverHandler, SessionInjectHandler, AbortHandler)
│   ├── outbox-utils.ts      # debouncedFlush, watchDir 유틸리티
│   ├── cron-outbox.ts       # 크론 결과 큐 처리 (data/users/{uid}/cron-outbox/)
│   ├── dm-commands.ts       # DM 커맨드 큐 처리 (run/dm-commands/)
│   ├── session-inbox.ts     # 세션 간 메시지 + abort 처리 (run/session-inbox/)
│   ├── progress-outbox.ts   # 툴 실행 상태 메시지 (run/progress/)
│   ├── query-handler.ts     # handleClaudeQuery — Claude 쿼리 실행 및 응답 전송
│   ├── commands.ts          # /start, /new, /s, /del, /connect, /debug, /logs 핸들러
│   ├── forum-sessions.ts    # 세션 상태 관리 (캐시 + debounced atomic write)
│   └── video.ts             # 비디오 프리뷰/프레임 추출
├── mcp/                     # MCP 서버 (각각 별도 stdio 프로세스로 실행)
│   ├── cron-manager-server.ts    # cron_create/list/delete/logs
│   ├── dm-manager-server.ts      # create/delete_topic, set/get_description
│   ├── send-file-server.ts       # send_file/send_files
│   ├── send-text-server.ts       # send_text (텍스트 메시지 전송)
│   ├── session-comm-server.ts    # ask_session, tell_session, abort_session, peek_session, list_sessions (세션 간 통신)
│   ├── macos-accessibility-server.ts # macOS 접근성 API (UI 자동화)
│   ├── ocr-server.ts             # OCR (tesseract 기반)
│   ├── paddleocr-server.ts       # PaddleOCR (한/중/일 정밀 OCR)
│   └── token-stats-server.ts     # 토큰 사용량 조회
└── app/                     # Next.js 대시보드
    ├── page.tsx             # 로그 뷰어 UI
    └── api/
        ├── logs/route.ts    # GET /api/logs
        └── sessions/route.ts # GET /api/sessions

meta/                        # 워크스페이스 템플릿
├── CLAUDE.md                # 포럼 세션용 CLAUDE.md 템플릿
├── skills/                  # 포럼 세션 스킬 템플릿
└── dm_skills/               # DM 세션 스킬 템플릿

cron/                        # 크론 작업 러너 (별도 Python 프로젝트)
├── runner.py                # pm2 크론에서 호출하는 Claude CLI 러너
├── pyproject.toml
└── uv.lock

scripts/
└── migrate-sessions.ts      # forum-sessions.json → sessions.db 마이그레이션
```

## 모듈 의존 관계 (DAG)

```
client.ts (leaf)
  ↑
helpers.ts → client
  ↑
logging.ts (leaf)          workspace.ts (leaf)
  ↑                            ↑
attachments.ts → client, helpers, video
  ↑
outbox.ts → client, helpers, workspace, forum-sessions
  ↑
query-handler.ts → client, helpers, logging, workspace, outbox, forum-sessions
  ↑
commands.ts → client, helpers, logging, workspace, forum-sessions
  ↑
bot.ts → all above (엔트리포인트)
```

순환 의존성 없음. `client.ts`가 leaf 모듈로 `bot` 인스턴스를 제공.

## 실행 방법

```bash
# 봇 실행
bun run src/telegram/bot.ts

# pm2로 실행 (환경변수 충돌 방지를 위해 .env를 강제 로드)
cd ~/claudeCodeTelegram && export $(cat .env | xargs) && pm2 start "bun run bot" --name claudeCodeTelegram --cwd ~/claudeCodeTelegram

# 대시보드 (별도 프로세스)
bun run dev       # 개발
bun run start     # 프로덕션
```

## 환경 변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` | Y | Telegram Bot API 토큰 |
| `TELEGRAM_ADMIN_USERS` | Y | 허용 사용자 ID (쉼표 구분) |
| `WHISPER_BIN` | Y | whisper 바이너리 경로 |
| `FFMPEG_BIN` | Y | ffmpeg 바이너리 경로 |
| `LOG_LEVEL` | N | pino 로그 레벨 (기본: `info`) |
| `NODE_ENV` | N | `development`면 pino-pretty 출력 |

## 로깅

- **프로세스 로그**: pino (JSON 구조화) — `src/core/logger.ts`
  - 개발 모드: `pino-pretty`로 가독성 좋은 출력
  - 프로덕션: JSON 한 줄 출력 (jq, Loki 등 연동 가능)
  - `LOG_LEVEL` 환경변수로 레벨 제어 (`debug`, `info`, `warn`, `error`, `fatal`)
- **활동 로그**: JSONL 파일 (`logs/*.jsonl`)
  - 사용자별/세션별 기록
  - 파일 크기 기반 로테이션 (5MB/파일, 총 200MB)

## 디렉토리 역할

| 경로 | 용도 |
|------|------|
| `logs/` | 활동 로그 JSONL + 토큰 쿼리 기록. 장기 보관. |
| `data/` | 영속 상태 — sessions.db, debug-users.json, pii-mappings/, users/ |
| `run/` | 런타임 IPC 큐 — session-inbox/, dm-commands/, dm-responses/, progress/, playwright-ports/ |

## 상태 관리

- `data/sessions.db` — 세션 매핑 (SQLite WAL 모드)
- `data/debug-users.json` — 디버그 모드 사용자 목록
- `data/users/{userId}/cron-outbox/pending.jsonl` — 크론 결과 큐
- `run/dm-commands/{userId}.jsonl` / `run/dm-responses/{userId}-{requestId}.json` — DM 커맨드 IPC
- `run/session-inbox/{userId}/{topicName}.jsonl` — 세션 간 메시지 (`type: "ask" | "tell" | "abort"`)

## Import 규칙

모든 import는 `@/` 절대경로 사용 (`@/*` → `./src/*`).

```typescript
import { logger } from "@/core/logger";
import { sendMsg } from "@/telegram/helpers";
```

## 주요 패턴

- **SQLite WAL**: 세션 상태는 `sessions.db` (WAL 모드, busy_timeout 5s)
- **Outbox pattern**: 크론/DM/세션간 통신 결과를 파일로 큐잉 → 봇이 폴링해서 전송
- **HTML fallback**: Claude 응답을 `markdownToTelegramHtml()`로 변환 → 실패시 plain text
- **Query abort**: 같은 토픽에 새 메시지 오면 이전 쿼리 abort
- **Playwright lifecycle**: 세션별 SSE 프로세스, 30분 idle 시 evict, 헬스체크 후 재시작
