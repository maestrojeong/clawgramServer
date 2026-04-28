"""
시스템 모니터링 크론 스크립트 — ludo 봇 형식과 통일.
nvidia-smi / /proc/stat / /proc/meminfo 사용.
runner.py가 stdout을 Claude에게 프롬프트로 전달.
"""

import subprocess
import time
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))


# ─── 진행바 ───────────────────────────────────────────────────
def bar(used, total, width=20):
    ratio = used / total if total > 0 else 0
    filled = int(ratio * width)
    empty = width - filled
    return f"[{'█' * filled}{'░' * empty}] {ratio * 100:5.1f}%"


# ─── 상태 아이콘 ──────────────────────────────────────────────
def status_icon(pct):
    if pct >= 80:
        return "🔴"
    elif pct >= 50:
        return "🟡"
    return "🟢"


# ─── GPU 정보 (nvidia-smi) ────────────────────────────────────
def get_gpu_info() -> list[dict]:
    result = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=index,name,temperature.gpu,utilization.gpu,"
            "memory.used,memory.total,power.draw,power.limit",
            "--format=csv,noheader,nounits",
        ],
        capture_output=True, text=True, timeout=10,
    )
    gpus = []
    for line in result.stdout.strip().splitlines():
        if not line.strip():
            continue
        parts = [p.strip() for p in line.split(",")]
        idx, name, temp, util, mem_used, mem_total, pwr, pwr_cap = parts
        gpus.append({
            "idx": int(idx),
            "name": name,
            "temp": float(temp),
            "util": float(util),
            "mem_used": float(mem_used),   # MiB
            "mem_total": float(mem_total), # MiB
            "pwr": float(pwr),
            "pwr_cap": float(pwr_cap),
        })
    return gpus


# ─── CPU 사용률 (/proc/stat, 1초 샘플링) ─────────────────────
def get_cpu_pct() -> float:
    def read_stat():
        with open("/proc/stat") as f:
            line = f.readline()
        vals = list(map(int, line.split()[1:]))
        return vals[3], sum(vals)  # idle, total

    idle1, total1 = read_stat()
    time.sleep(1)
    idle2, total2 = read_stat()
    diff_total = total2 - total1
    diff_idle  = idle2  - idle1
    if diff_total == 0:
        return 0.0
    return round(100.0 * (1 - diff_idle / diff_total), 1)


# ─── RAM 정보 (/proc/meminfo) ─────────────────────────────────
def get_ram_info():
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":")
            info[k.strip()] = int(v.split()[0])  # kB
    total_gb = info["MemTotal"]     / 1024 / 1024
    avail_gb = info["MemAvailable"] / 1024 / 1024
    used_gb  = total_gb - avail_gb
    return round(used_gb, 1), round(total_gb, 0)


# ─── 리포트 생성 ──────────────────────────────────────────────
def build_report() -> str:
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M")
    gpus = get_gpu_info()
    cpu_pct = get_cpu_pct()
    ram_used, ram_total = get_ram_info()

    total_mem_used  = sum(g["mem_used"]  for g in gpus)
    total_mem_total = sum(g["mem_total"] for g in gpus)
    total_pwr       = sum(g["pwr"]       for g in gpus)
    total_pwr_cap   = sum(g["pwr_cap"]   for g in gpus)

    lines = []
    lines.append(f"🖥️ 시스템 리포트 · {now}")
    lines.append("━" * 40)

    # GPU 섹션
    lines.append("\n🎮 GPU 현황")
    lines.append("─" * 40)
    for g in gpus:
        mem_pct = g["mem_used"] / g["mem_total"] * 100
        icon = status_icon(mem_pct)
        lines.append(f" GPU{g['idx']} {icon} {g['name']}")
        lines.append(
            f"      메모리 {g['mem_used']/1024:.1f}/{g['mem_total']/1024:.0f} GiB  "
            f"{bar(g['mem_used'], g['mem_total'])}"
        )
        lines.append(
            f"      연산 {g['util']:4.0f}%  |  온도 {g['temp']:.0f}°C  |  전력 {g['pwr']:.0f}/{g['pwr_cap']:.0f}W"
        )

    # 전체 요약
    lines.append(
        f"\n📊 전체 GPU 메모리: {total_mem_used/1024:.1f} / {total_mem_total/1024:.0f} GiB  "
        f"{bar(total_mem_used, total_mem_total)}"
    )
    lines.append(f"⚡ 전체 전력:       {total_pwr:.0f} / {total_pwr_cap:.0f} W")

    # 시스템 리소스
    lines.append("\n💻 시스템 리소스")
    lines.append("─" * 40)
    lines.append(f" CPU   {status_icon(cpu_pct)} {bar(cpu_pct, 100)}")
    ram_pct = ram_used / ram_total * 100 if ram_total > 0 else 0
    lines.append(f" RAM   {status_icon(ram_pct)} {bar(ram_used, ram_total)}  {ram_used} / {ram_total:.0f} GiB")

    # 분석
    lines.append("\n💡 분석")
    lines.append("─" * 40)
    busy_gpus   = [g for g in gpus if g["mem_used"] / g["mem_total"] >= 0.5]
    idle_gpus   = [g for g in gpus if g["mem_used"] / g["mem_total"] < 0.05]
    active_gpus = [g for g in gpus if g["util"] > 10]
    if busy_gpus:
        lines.append(f" ⚠️  GPU {', '.join(str(g['idx']) for g in busy_gpus)} 메모리 50% 초과 사용 중")
    if idle_gpus:
        lines.append(f" ✅ GPU {', '.join(str(g['idx']) for g in idle_gpus)} 거의 유휴 상태")
    if active_gpus:
        lines.append(f" 🔄 GPU {', '.join(str(g['idx']) for g in active_gpus)} 연산 활성 (>10%)")
    if cpu_pct >= 80:
        lines.append(f" ⚠️  CPU 사용률 높음 ({cpu_pct:.1f}%)")
    elif cpu_pct >= 50:
        lines.append(f" 🟡 CPU 보통 사용 중 ({cpu_pct:.1f}%)")
    else:
        lines.append(f" ✅ CPU 여유 있음 ({cpu_pct:.1f}%)")
    if ram_pct >= 80:
        lines.append(f" ⚠️  시스템 RAM 높음 ({ram_pct:.1f}%)")
    else:
        lines.append(f" ✅ 시스템 RAM 여유 있음 ({ram_pct:.1f}%)")

    return "\n".join(lines)


if __name__ == "__main__":
    report = build_report()
    print(f"아래 서버 상태 리포트를 그대로 사용자에게 전달해주세요 (수정하지 말고):\n\n{report}")
