#!/bin/bash
# Launchd-safe launcher for the brain-3d rebuild watcher.
# Cherry-picked from duckbot-rag-memory's run-watcher.sh pattern.
#
# Why this lives in ~/Library/Application Support/ and NOT in ~/Desktop/brain-3d/:
# launchd blocks running scripts under ~/Desktop (gatekeeper/provenance). We
# keep a thin launcher here that knows where the python script and venv live.
set -euo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="${HOME:-/Users/duckets}"
export PYTHONUNBUFFERED=1

# Hardcoded paths (do NOT resolve from BASH_SOURCE — that breaks under "Application Support")
BRAIN3D_REPO="/Users/duckets/Desktop/brain-3d"
PYTHON="/Users/duckets/Desktop/duckbot-rag-memory/.venv/bin/python"
LOG_DIR="$HOME/Library/Application Support/brain-3d/logs"

mkdir -p "$LOG_DIR" 2>/dev/null || true

cd "$BRAIN3D_REPO"
exec "$PYTHON" "$BRAIN3D_REPO/scripts/rebuild-watcher.py" --interval 60 >> "$LOG_DIR/rebuild.log" 2>&1
