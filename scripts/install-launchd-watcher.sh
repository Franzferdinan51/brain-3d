#!/bin/bash
# install-launchd-watcher.sh — install/uninstall the brain-3d rebuild watcher.
#
# Background: GitNexus auto-detects stale indexes after commits and rebuilds.
# We replicate that pattern with launchd polling brain_export.md + graph.db
# mtimes; when either changes, rebuild public/brain-graph.json.
#
# Usage:
#     ./scripts/install-launchd-watcher.sh install
#     ./scripts/install-launchd-watcher.sh uninstall
#     ./scripts/install-launchd-watcher.sh status
set -euo pipefail

PLIST_LABEL="com.brain3d.rebuild-watcher"
PLIST_SRC="$HOME/Desktop/brain-3d/scripts/${PLIST_LABEL}.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LAUNCHER_SRC="$HOME/Desktop/brain-3d/scripts/launchd/rebuild-watcher.sh"
LAUNCHER_DST="$HOME/Library/Application Support/brain-3d/scripts/rebuild-watcher.sh"
LOG_DIR="$HOME/Library/Application Support/brain-3d/logs"

cmd="${1:-status}"

install() {
    echo "[install] copying launcher to launchd-safe location…"
    mkdir -p "$(dirname "$LAUNCHER_DST")" "$LOG_DIR"
    cp "$LAUNCHER_SRC" "$LAUNCHER_DST"
    chmod +x "$LAUNCHER_DST"
    echo "[install] copying plist to ~/Library/LaunchAgents/…"
    cp "$PLIST_SRC" "$PLIST_DST"
    echo "[install] loading via launchctl…"
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST"
    echo "[install] done. logs: $LOG_DIR/rebuild.log"
}

uninstall() {
    echo "[uninstall] unloading…"
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    rm -f "$PLIST_DST"
    rm -f "$LAUNCHER_DST"
    echo "[uninstall] done"
}

status() {
    if [[ -f "$PLIST_DST" ]]; then
        echo "plist installed: $PLIST_DST"
        launchctl list | grep -i brain3d || echo "  (not loaded — try 'install')"
    else
        echo "plist NOT installed"
    fi
    echo "launcher: $LAUNCHER_DST $([ -f "$LAUNCHER_DST" ] && echo 'OK' || echo 'MISSING')"
    echo "log: $LOG_DIR/rebuild.log $([ -f "$LOG_DIR/rebuild.log" ] && echo 'OK' || echo 'EMPTY')"
}

case "$cmd" in
    install)   install ;;
    uninstall) uninstall ;;
    status)    status ;;
    *)         echo "usage: $0 {install|uninstall|status}"; exit 1 ;;
esac
