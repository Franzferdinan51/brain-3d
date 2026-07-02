#!/usr/bin/env python3
"""
rebuild-watcher.py - auto-regenerate brain-3d's brain-graph.json when the
source-of-truth (brain_export.md, graph.db) changes in duckbot-rag-memory.

Cherry-picked from GitNexus's post-commit / stale-index detection pattern.
See: https://github.com/abhigyanpatwari/GitNexus/blob/main/GUARDRAILS.md
  "Stale graph after edits" → runs `analyze` (here: build-graph-json.py)
  when HEAD changes; ours runs when the brain export changes.

Why this exists:
- brain-3d/public/brain-graph.json is gitignored (per .gitignore).
  So a git post-commit hook in brain-3d would NOT trigger when the brain
  data changes. We need an OUT-OF-BAND watcher that polls the brain files
  and rebuilds the visualization data.

This watcher:
1. Polls mtime of brain_export.md and graph.db (default 60s).
2. If either changed since last successful build → run build-graph-json.py.
3. Logs to ~/Library/Application Support/brain-3d/logs/rebuild.log.
4. Exit-code 0 on clean rebuild → loop. Exit-code !=0 → backoff & retry.

Run modes:
    python3 scripts/rebuild-watcher.py          # foreground, loop forever
    python3 scripts/rebuild-watcher.py --once   # run one pass, exit
    python3 scripts/rebuild-watcher.py --status # is a watcher running?

Configuration via env:
    BRAIN_DIR       (default: ~/Desktop/duckbot-rag-memory)
    BRAIN3D_DIR     (default: ~/Desktop/brain-3d)
    REBUILD_INTERVAL_SEC (default: 60)
    PYTHON          (default: <this venv> python)

This is the SECOND watcher in our stack - the first is the memory-watcher
that ingests markdown into the brain. This one watches the BRAIN FILES
and refreshes the 3D graph JSON. Together they form a two-tier pipeline:
    markdown → brain_export.md → brain-graph.json → 3D viz
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_BRAIN_DIR = Path.home() / "Desktop" / "duckbot-rag-memory"
DEFAULT_BRAIN3D_DIR = Path.home() / "Desktop" / "brain-3d"
DEFAULT_EXPORT = DEFAULT_BRAIN_DIR / "data" / "brain_export.md"
DEFAULT_GRAPH = DEFAULT_BRAIN_DIR / "data" / "graph.db"
DEFAULT_CHROMA = DEFAULT_BRAIN_DIR / "data" / "chroma"
DEFAULT_BUILD_SCRIPT = DEFAULT_BRAIN3D_DIR / "scripts" / "build-graph-json.py"
DEFAULT_OUT = DEFAULT_BRAIN3D_DIR / "public" / "brain-graph.json"
DEFAULT_CHROMA_COLLECTIONS = ["duckbot_episodic"]  # default: episodic only; opt in to others with REBUILD_COLLECTIONS env
DEFAULT_STATE = (
    Path.home() / "Library" / "Application Support" / "brain-3d" / "last-build.json"
)
DEFAULT_LOG_DIR = (
    Path.home() / "Library" / "Application Support" / "brain-3d" / "logs"
)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _mtime_ms(path: Path) -> int:
    try:
        return int(path.stat().st_mtime * 1000)
    except FileNotFoundError:
        return 0


def _load_state() -> dict:
    if DEFAULT_STATE.exists():
        try:
            import json

            return json.loads(DEFAULT_STATE.read_text())
        except Exception:
            pass
    return {}


def _save_state(state: dict) -> None:
    DEFAULT_STATE.parent.mkdir(parents=True, exist_ok=True)
    import json

    DEFAULT_STATE.write_text(json.dumps(state, indent=2))


def needs_rebuild(
    export_path: Path,
    graph_path: Path,
    chroma_path: Path,
    prev: dict,
) -> bool:
    """Return True if any source file changed since the last successful build."""
    export_mtime = _mtime_ms(export_path)
    graph_mtime = _mtime_ms(graph_path)
    # also include chroma.sqlite3 + per-collection dirs in the staleness check
    chroma_mtime = max(
        [_mtime_ms(chroma_path / "chroma.sqlite3")]
        + [_mtime_ms(p) for p in chroma_path.glob("*/") if p.is_dir()]
        + [0]
    )
    prev_chroma = prev.get("chroma_mtime_ms", 0)
    return (
        export_mtime > prev.get("export_mtime_ms", 0)
        or graph_mtime > prev.get("graph_mtime_ms", 0)
        or chroma_mtime > prev_chroma
    )


def run_build(log_handle) -> bool:
    """Run build-graph-json.py with chroma similarity edges. Return True on success."""
    cmd = [
        sys.executable,
        str(DEFAULT_BUILD_SCRIPT),
        "--export",
        str(DEFAULT_EXPORT),
        "--graph",
        str(DEFAULT_GRAPH),
        "--chroma",
        str(DEFAULT_CHROMA),
        "--chroma-collections",
        *(
            os.environ.get("REBUILD_COLLECTIONS", "").split()
            if os.environ.get("REBUILD_COLLECTIONS")
            else DEFAULT_CHROMA_COLLECTIONS
        ),
        "--knn-k",
        str(os.environ.get("REBUILD_KNN_K", 1)),
        "--min-similarity",
        str(os.environ.get("REBUILD_MIN_SIMILARITY", 0.90)),
        "--out",
        str(DEFAULT_OUT),
    ]   
    log_handle.write(f"[{_now_ms()}] running: {' '.join(cmd)}\n")
    log_handle.flush()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if proc.returncode == 0:
        log_handle.write(f"[{_now_ms()}] success: {proc.stdout.strip()[-500:]}\n")
        return True
    else:
        log_handle.write(f"[{_now_ms()}] FAILURE (rc={proc.returncode})\n")
        log_handle.write(f"  stdout: {proc.stdout[-500:]}\n")
        log_handle.write(f"  stderr: {proc.stderr[-500:]}\n")
        return False


def loop_watch(interval_sec: int) -> int:
    """Main poll loop. Returns process exit code."""
    DEFAULT_LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = DEFAULT_LOG_DIR / "rebuild.log"
    log_handle = log_path.open("a", buffering=1)  # line-buffered

    log_handle.write(f"[{_now_ms()}] brain-3d rebuild-watcher started\n")
    log_handle.write(f"  brain_dir = {DEFAULT_BRAIN_DIR}\n")
    log_handle.write(f"  brain3d_dir = {DEFAULT_BRAIN3D_DIR}\n")
    log_handle.write(f"  interval = {interval_sec}s\n")
    log_handle.flush()

    backoff = 0
    while True:
        try:
            prev = _load_state()
            if needs_rebuild(DEFAULT_EXPORT, DEFAULT_GRAPH, DEFAULT_CHROMA, prev):
                log_handle.write(f"[{_now_ms()}] stale detected, rebuilding…\n")
                if run_build(log_handle):
                    _save_state(
                        {
                            "export_mtime_ms": _mtime_ms(DEFAULT_EXPORT),
                            "graph_mtime_ms": _mtime_ms(DEFAULT_GRAPH),
                            "chroma_mtime_ms": _mtime_ms(DEFAULT_CHROMA / "chroma.sqlite3"),
                            "built_at_ms": _now_ms(),
                        }
                    )   
                    backoff = 0
                else:
                    backoff = min(backoff + 1, 5)
            time.sleep(interval_sec + backoff * interval_sec)
        except KeyboardInterrupt:
            log_handle.write(f"[{_now_ms()}] interrupted, exiting\n")
            return 0
        except Exception as exc:
            log_handle.write(f"[{_now_ms()}] ERROR: {exc!r}\n")
            time.sleep(interval_sec)


def run_once() -> int:
    """One-pass mode (for cron or manual triggers)."""
    prev = _load_state()
    if not needs_rebuild(DEFAULT_EXPORT, DEFAULT_GRAPH, DEFAULT_CHROMA, prev):
        print("up to date", flush=True)
        return 0
    print("rebuilding…", flush=True)
    DEFAULT_LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = DEFAULT_LOG_DIR / "rebuild.log"
    with log_path.open("a", buffering=1) as log:
        ok = run_build(log)
    if ok:
        _save_state(
            {
                "export_mtime_ms": _mtime_ms(DEFAULT_EXPORT),
                "graph_mtime_ms": _mtime_ms(DEFAULT_GRAPH),
                "chroma_mtime_ms": _mtime_ms(DEFAULT_CHROMA / "chroma.sqlite3"),
                "built_at_ms": _now_ms(),
            }
        )
        return 0
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--once", action="store_true", help="run one pass then exit")
    parser.add_argument(
        "--interval", type=int, default=int(os.environ.get("REBUILD_INTERVAL_SEC", 60)),
        help="poll interval (default 60s, env: REBUILD_INTERVAL_SEC)",
    )
    args = parser.parse_args()
    if args.once:
        return run_once()
    return loop_watch(args.interval)


if __name__ == "__main__":
    sys.exit(main())
