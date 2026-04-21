"""
Cron job runner.
Executes a Python script, captures its stdout as a prompt,
runs claude -p (--resume if session exists), and writes output to outbox.

Usage:
  uv run cron/runner.py --script email_check.py --topic 신건 --user-id 123 --cron-name email-check
"""

import argparse
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CRON_DIR = PROJECT_ROOT / "cron"
DATA_DIR = PROJECT_ROOT / "data"
USERS_DIR = DATA_DIR / "users"
SESSIONS_DB = DATA_DIR / "sessions.db"


def user_dir(user_id: str) -> Path:
    return USERS_DIR / user_id


def lock_dir(user_id: str) -> Path:
    return user_dir(user_id) / "active-queries"


def cron_lock_dir(user_id: str) -> Path:
    return user_dir(user_id) / "cron-locks"


def outbox_dir(user_id: str) -> Path:
    return user_dir(user_id) / "cron-outbox"


CLAUDE_BIN = Path.home() / ".local" / "bin" / "claude"


def get_cron_session_id(server_name: str, topic: str) -> str | None:
    """Look up cron-dedicated session ID from SQLite."""
    try:
        con = sqlite3.connect(str(SESSIONS_DB), timeout=5)
        row = con.execute(
            "SELECT cron_session_id FROM topics WHERE server_name = ? AND name = ?",
            (server_name, topic),
        ).fetchone()
        con.close()
        return row[0] if row and row[0] else None
    except Exception:
        return None


def set_cron_session_id(server_name: str, topic: str, session_id: str):
    """Save cron session ID to SQLite."""
    try:
        con = sqlite3.connect(str(SESSIONS_DB), timeout=5)
        con.execute(
            "UPDATE topics SET cron_session_id = ? WHERE server_name = ? AND name = ?",
            (session_id, server_name, topic),
        )
        con.commit()
        con.close()
    except Exception as e:
        print(f"[runner] Failed to save cron session ID: {e}", file=sys.stderr)


def is_locked(user_id: str, topic: str) -> bool:
    """Check if there's an active query on this topic."""
    state_file = lock_dir(user_id) / f"{topic}.json"
    if not state_file.exists():
        return False
    # Stale lock check (older than 10 minutes)
    try:
        state = json.loads(state_file.read_text().strip())
        from datetime import datetime, timezone
        since = datetime.fromisoformat(state["since"]).replace(tzinfo=timezone.utc)
        elapsed = time.time() - since.timestamp()
        if elapsed > 600:
            state_file.unlink(missing_ok=True)
            return False
    except Exception:
        pass
    return True


def wait_for_unlock(user_id: str, topic: str, timeout: int = 300):
    """Wait until the topic is unlocked, polling every 5 seconds."""
    start = time.time()
    while is_locked(user_id, topic):
        if time.time() - start > timeout:
            print(f"[runner] Timeout waiting for unlock: {user_id}-{topic}", file=sys.stderr)
            return False
        time.sleep(5)
    return True


def write_outbox(user_id: str, topic: str, cron_name: str, message: str, files: list[str] | None = None, session_texts: list[str] | None = None, new_cron_session_id: str | None = None):
    """Write result to outbox for bot.ts to pick up."""
    out_dir = outbox_dir(user_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    outbox_file = out_dir / "pending.jsonl"
    actual_message = "\n\n".join(session_texts) if session_texts else message
    entry = {
        "userId": user_id,
        "topic": topic,
        "cronName": cron_name,
        "message": actual_message,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    if files:
        entry["files"] = files
    if new_cron_session_id:
        entry["newCronSessionId"] = new_cron_session_id
    with open(outbox_file, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def main():
    parser = argparse.ArgumentParser(description="Cron job runner")
    parser.add_argument("--script", required=True, help="Python script in cron/ to run")
    parser.add_argument("--topic", required=True, help="Telegram topic name")
    parser.add_argument("--user-id", required=True, help="User ID")
    parser.add_argument("--server-name", required=True, help="Server (bot) name for topic lookups")
    parser.add_argument("--cron-name", default="unknown", help="Cron job name")
    args = parser.parse_args()

    script_path = CRON_DIR / args.script
    if not script_path.exists():
        print(f"[runner] Script not found: {script_path}", file=sys.stderr)
        sys.exit(1)

    # 0. Skip if already running (prevent overlap)
    cl_dir = cron_lock_dir(args.user_id)
    cl_dir.mkdir(parents=True, exist_ok=True)
    cron_lock = cl_dir / f"{args.cron_name}.lock"
    if cron_lock.exists():
        # Stale lock check (older than 30 minutes)
        try:
            ts = float(cron_lock.read_text().strip())
            if time.time() - ts < 1800:
                print(f"[runner] Skipping: {args.cron_name} is already running", file=sys.stderr)
                sys.exit(0)
        except Exception:
            pass
    cron_lock.write_text(str(time.time()))

    try:
        _run_job(args, script_path)
    finally:
        cron_lock.unlink(missing_ok=True)


def _run_job(args, script_path):
    # 1. Run the script to get prompt
    try:
        result = subprocess.run(
            [sys.executable, str(script_path)],
            capture_output=True,
            text=True,
            timeout=3600,
        )
        prompt = result.stdout.strip()
        if not prompt:
            print(f"[runner] Script produced no output (normal - nothing to report)", file=sys.stderr)
            sys.exit(0)
    except subprocess.TimeoutExpired:
        print(f"[runner] Script timed out", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"[runner] Script error: {e}", file=sys.stderr)
        sys.exit(1)

    # 2. Wait for active query to finish
    if not wait_for_unlock(args.user_id, args.topic):
        write_outbox(args.user_id, args.topic, args.cron_name,
                     f"[cron skipped] Topic '{args.topic}' was busy for too long.")
        sys.exit(1)

    # 3. Run claude -p with stream-json (to capture tool_use events for file sending)
    cron_session_id = get_cron_session_id(args.server_name, args.topic)

    # MCP config for send-file and send-text
    send_file_server = str(PROJECT_ROOT / "src" / "mcp" / "send-file-server.ts")
    send_text_server = str(PROJECT_ROOT / "src" / "mcp" / "send-text-server.ts")
    mcp_config = json.dumps({
        "mcpServers": {
            "send-file": {
                "command": "bun",
                "args": ["run", send_file_server, f"--user-id={args.user_id}"],
            },
            "send-text": {
                "command": "bun",
                "args": ["run", send_text_server],
            },
        }
    })

    claude_cmd = [
        str(CLAUDE_BIN), "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--mcp-config", mcp_config,
    ]
    if cron_session_id:
        claude_cmd.extend(["--resume", cron_session_id])

    response = ""
    files: list[str] = []
    session_texts: list[str] = []
    new_session_id: str | None = None

    try:
        proc = subprocess.Popen(
            claude_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert proc.stdout is not None

        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            event_type = event.get("type", "")

            # Extract file paths from tool_use events (send_file / send_files)
            if event_type == "assistant":
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") != "tool_use":
                        continue
                    tool_name = block.get("name", "")
                    tool_input = block.get("input", {})
                    if tool_name.endswith("send_file"):
                        fp = tool_input.get("file_path", "")
                        if fp:
                            files.append(fp)
                    elif tool_name.endswith("send_files"):
                        for fp in tool_input.get("file_paths", []):
                            if fp:
                                files.append(fp)
                    elif tool_name.endswith("send_text"):
                        text = tool_input.get("text", "")
                        if text:
                            session_texts.append(text)

            # Extract result and session_id from the final result event
            elif event_type == "result":
                response = event.get("result", "")
                new_session_id = event.get("session_id")

        proc.wait(timeout=60)

    except subprocess.TimeoutExpired:
        if proc:
            proc.kill()
        response = "[cron error] Claude CLI timed out"
    except Exception as e:
        response = f"[cron error] {e}"

    if not response:
        response = "(empty response)"

    # Deduplicate files while preserving order
    seen: set[str] = set()
    unique_files = []
    for f in files:
        if f not in seen:
            seen.add(f)
            unique_files.append(f)

    write_outbox(args.user_id, args.topic, args.cron_name, response, unique_files or None, session_texts or None, new_session_id or None)
    print(f"[runner] Done. Output written to outbox for topic '{args.topic}'" +
          (f" ({len(unique_files)} files: {unique_files})" if unique_files else " (no files)") +
          (f" ({len(session_texts)} session texts merged)" if session_texts else ""))


if __name__ == "__main__":
    main()
