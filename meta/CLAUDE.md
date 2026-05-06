
## 디렉토리 구조
```
user_{userId}/
├── CLAUDE.md                    # 이 문서 (프로젝트 컨텍스트)
├── workspace/                   # 주요 작업 공간
│   └── tmp/                     # 임시 다운로드/캐시
├── tmp/                         # 임시 파일 (정기 삭제 대상)
└── .claude/
    └── agents/                  # 자율 에이전트 정의
```

## 세션 간 통신

다른 세션(토픽)에 정보를 물어보거나 전달할 때 MCP 도구를 사용한다.

- `mcp__session-comm__list_sessions` — 현재 사용 가능한 세션(토픽) 목록 조회
- `mcp__session-comm__ask_session` — 다른 세션에 질문하고 결과를 **내 컨텍스트로 가져옴**
  - `to`: 토픽 이름 (예: "law-test", "youtube", "coding")
  - `message`: 질문 또는 전달할 내용
  - 대상 세션이 포크되어 풀 도구로 처리 → 응답이 이 세션에 자동 주입됨
  - 내 다음 행동을 좌우하는 결과가 필요할 때만 사용 (코드 리뷰 결론, fact check 등)
  - 결과를 유저가 대상 토픽에서 읽기만 하면 되는 경우엔 `tell_session`을 사용 (컨텍스트 절약)

- `mcp__session-comm__tell_session` — 다른 세션에 작업/컨텍스트를 **단방향 전달** (응답 없음)
  - `to`: 대상 토픽 이름
  - `message`: 전달할 내용
  - 메시지는 대상 토픽 히스토리에 기록되고 Claude가 비동기로 처리, 결과는 대상 토픽에 남음
  - 위임 대상: 오래 걸리는 작업, 자체 완결 작업(실험·벤치마크·모니터링·파일 생성), 상태 업데이트, 컨텍스트 주입
  - 받은 세션은 다시 `tell_session`을 사용할 수 없음 (무한루프 방지)
  - 판단 기준: "이 결과가 내 컨텍스트에 필요한가?" → 아니오 = `tell_session`, 예 = `ask_session`

- `mcp__session-comm__abort_session` — 다른 세션의 실행 중인 쿼리 중단
  - `to`: 대상 토픽 이름
  - `peek_session`으로 busy 확인 후 사용

- `mcp__session-comm__peek_session` — 모든 세션의 실행 중/유휴 상태 조회

- `mcp__session-comm__ask_cron` — 이 토픽의 크론 세션에 질문 (크론이 수집한 데이터 조회)
  - `message`: 질문 내용
  - 예: 뉴스, 주식, 모니터링 결과 등 크론이 쌓은 데이터 확인 시 사용

## depth와 체인 제약

- `tell_session`은 최대 **depth 3**까지만 체이닝 가능 (`MAX_TELL_DEPTH = 3`).
  - 유저 → A: depth 0 → A가 B에게 tell: depth 1 → B가 C에게 tell: depth 2 → C가 D에게 tell: depth 3 → 더 이상 tell 불가.
- `ask_session`은 대상 세션을 **silent fork**로 띄워서 응답만 받아옴. fork는 reply-only 모드라 outbound 도구(ask/tell/abort)를 쓸 수 없음 → 무한 루프 불가.
  - 응답이 caller에게 주입될 때 caller의 원래 depth가 복원됨 (tell 체인 카운트가 ask 호출로 인해 리셋되지 않도록).
- 진행 상황(tool use, 중간 과정)은 이 토픽에 실시간으로 표시됨.

## 핵심 규칙

### 파일 전송
- `send_file` MCP 도구 사용
- 응답에 `[FILE:/absolute/path]` 태그 포함 필수
- 파일명은 ASCII만 (한글 금지)
- **txt 파일 전송 지양** → PDF로 변환 후 전송

### 정기 작업 (Cron)
- **pm2 + uv 기반 cron**: 세션과 독립적으로 영속 실행
- 스크립트 위치: `~/clawgramServer/cron/`
- 실행 cwd: 프로젝트 루트 (`PROJECT_ROOT`)
- MCP 도구:
  - `mcp__cron-manager__cron_create` — cron job 생성 (name, script, cron, topic)
  - `mcp__cron-manager__cron_list` — 현재 cron job 목록
  - `mcp__cron-manager__cron_delete` — cron job 삭제
  - `mcp__cron-manager__cron_logs` — cron job 로그 조회
- 스크립트의 stdout → `claude -p` 프롬프트로 사용, 결과는 topic에 전송
- 활성 쿼리가 있으면 자동 대기 후 실행 (세션 충돌 방지)
- 의존성 추가: `cd ~/clawgramServer/cron && uv add {패키지}`
- **내장 `/loop`, `CronCreate`는 사용하지 않는다** (세션 끊기면 소멸)

### 작업 디렉토리 (cwd)
토픽 생성 시 `cwd` 파라미터로 작업 디렉토리 지정 가능. 미지정 시 ~/.

### 폴더 정리 규칙
- `tmp/`: 일회성 파일
- 루트에 파일 흩뿌리지 않기 → 용도별 폴더에 정리
