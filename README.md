# Claude Code Telegram Bot

Telegram 포럼 기반 멀티세션 Claude AI 봇.

> 포럼 그룹의 각 토픽이 독립된 Claude 세션으로 동작합니다. 세션 간 통신, 크론 작업, DM 온보딩을 지원합니다.

## 프로젝트 구조

```
src/
├── core/                    # Telegram 비의존 핵심 로직
│   ├── claude.ts            # Claude Agent SDK 래퍼, ClaudeEvent 스트림
│   ├── config.ts            # 경로 상수, MCP 서버 설정, 시스템 프롬프트
│   ├── logger.ts            # pino 기반 구조화 로거
│   ├── memory.ts            # 메모리 관리
│   ├── mcp-config.ts        # MCP 서버 구성 빌더
│   ├── text-extractor.ts    # 텍스트 추출 유틸리티
│   ├── token-stats.ts       # 토큰 카운팅
│   ├── types.ts             # ClaudeEvent, ClaudeQueryOptions 타입
│   └── prompts/
│       ├── sessions/        # 세션별 시스템 프롬프트
│       └── agents/          # 자율 에이전트 프롬프트
├── telegram/                # Telegram 봇 레이어
│   ├── bot.ts               # 엔트리포인트 — 이벤트 바인딩, 라우팅, cleanup
│   ├── client.ts            # TelegramBot 인스턴스, 허용 사용자 목록
│   ├── helpers.ts           # withRetry, sendMsg/Photo/Doc, splitMessage, sendFileToChat
│   ├── logging.ts           # 활동 로그 JSONL 기록/조회, 파일 크기 기반 로테이션
│   ├── workspace.ts         # 사용자 워크스페이스 초기화, 디버그 토글
│   ├── attachments.ts       # 파일 다운로드, Whisper 음성인식, buildPromptFromMessage
│   ├── outbox.ts            # cron/DM/세션 간 통신 outbox 폴링
│   ├── query-handler.ts     # handleClaudeQuery — Claude 쿼리 실행 및 응답 전송
│   ├── commands.ts          # /start, /new, /s, /del, /connect, /debug 핸들러
│   ├── forum-sessions.ts    # 세션 상태 관리 (bun:sqlite, WAL 모드)
│   └── video.ts             # 비디오 프리뷰, 프레임 추출
├── mcp/                     # MCP 서버 (각각 별도 stdio 프로세스)
│   ├── cron-manager-server.ts    # cron_create/list/delete/logs
│   ├── dm-manager-server.ts      # create/delete_topic, set/get_description
│   ├── send-file-server.ts       # send_file/send_files
│   ├── send-text-server.ts       # send_text (텍스트 메시지 전송)
│   ├── session-comm-server.ts    # 세션 간 통신 (ask/command/orchestrate)
│   ├── session-comm-utils.ts     # 세션 통신 유틸리티 (fork, progress)
│   └── token-stats-server.ts     # 토큰 사용량 조회
└── app/                     # Next.js 로그 대시보드
    ├── page.tsx
    └── api/
        ├── logs/route.ts
        └── sessions/route.ts

meta/                        # 워크스페이스 템플릿
└── CLAUDE.md                # 포럼 세션용 CLAUDE.md 템플릿

cron/                        # 크론 작업 러너 (별도 Python 프���젝트)
├── runner.py
├── pyproject.toml
└── uv.lock
```

## 실행

```bash
# 봇 실행
bun run src/telegram/bot.ts

# pm2로 실행 (권장)
cd ~/clawgramServer && \
  export $(cat .env | xargs) && \
  pm2 start "bun run bot" --name clawgramServer --cwd ~/clawgramServer

# 대시보드
bun run dev    # 개발
bun run start  # 프로덕션
```

## 환경 변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` | Y | Telegram Bot API 토큰 |
| `TELEGRAM_ADMIN_USERS` | Y | 허용 사용자 ID (쉼표 구분) |
| `WHISPER_BIN` | Y | whisper 바이너리 경로 |
| `FFMPEG_BIN` | Y | ffmpeg 바이너리 경로 |
| `FFPROBE_BIN` | N | ffprobe 바이너리 경로 |
| `LOG_LEVEL` | N | pino 로그 레벨 (기본: `info`) |
| `NODE_ENV` | N | `development`이면 pino-pretty 출력 |

> `WHISPER_BIN`, `FFMPEG_BIN` 미설정 시 봇 시작 시점에 즉시 종료됩니다.

## 시스템 의존성

- **[Claude Code CLI](https://claude.ai/code)** — `~/.local/bin/claude`에 설치
- **whisper** — 음성 인식: `pip install openai-whisper`
- **ffmpeg / ffprobe** — 오디오/비디오 변환: `brew install ffmpeg`
- **pm2** — 크론 작업 스케줄링: `npm install -g pm2`
- **uv** — 크론 Python 스크립트 실행: `brew install uv`
- **pandoc** — 문서 변환 (docx, pptx 등): `brew install pandoc`
- **pdftotext** — PDF 텍스트 추출: `brew install poppler`

### 크론 Python 환경

```bash
cd cron && uv sync
```

## 주요 설계 패턴

| 패턴 | 위치 | 설명 |
|------|------|------|
| SQLite WAL | `forum-sessions.ts` | WAL 모드 + busy_timeout 5s — 멀티프로세스(MCP 서버) 동시 접근 안전 |
| Outbox | `outbox.ts` | 크론/DM/세션 간 결과를 파일로 큐잉 → fs.watch + 60s fallback 폴링 |
| Query abort | `query-handler.ts` | 같은 토픽에 새 메시지 오면 이전 쿼리 abort, inject는 큐잉 |
| Inject suppression | `query-handler.ts` | 세션→세션 inject 실행 시 수신 토픽에 출력 없음 |
| HTML fallback | `helpers.ts` | Claude 응답을 markdownToTelegramHtml 변환 → 실패 시 plain text |

## ���태 파일

| 경로 | 내용 |
|------|------|
| `data/sessions.db` | 세션 DB (users + topics 테이블, SQLite WAL) |
| `data/debug-users.json` | 디버그 모드 사용자 목록 |
| `data/users/{userId}/cron-outbox/pending.jsonl` | 크론 결과 큐 |
| `run/dm-commands/*.jsonl` | DM 커맨드 outbox |
| `run/dm-responses/*.json` | DM 응답 outbox |
| `run/session-inbox/{userId}/*.jsonl` | 세션 간 통신 큐 |

### sessions.db 스키마

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  forum_group_ids TEXT NOT NULL DEFAULT '[]',
  forum_group_titles TEXT NOT NULL DEFAULT '{}',
  dm_session_id TEXT,
  communicate_thread_id INTEGER
);

CREATE TABLE topics (
  user_id TEXT NOT NULL REFERENCES users(id),
  forum_group_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  message_thread_id INTEGER NOT NULL,
  session_id TEXT,
  cron_session_id TEXT,
  created_at TEXT NOT NULL,
  description TEXT,
  model TEXT,
  cwd TEXT,
  effort TEXT CHECK (effort IN ('low', 'medium', 'high', 'max')),
  PRIMARY KEY (user_id, name),
  UNIQUE (forum_group_id, message_thread_id)
);
```

## 로깅

- **프로세스 로그**: pino (JSON) — `LOG_LEVEL` 환경변수로 제어
- **활동 로그**: `logs/*.jsonl` — 사용자/세��별, 5MB/파일, 총 200MB 로테이션
