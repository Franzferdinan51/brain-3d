#!/usr/bin/env python3
"""Remove leftover 'Connected only' chip from HUD."""
from pathlib import Path

app_tsx = Path("/Users/duckets/Desktop/brain-3d/src/App.tsx")
src = app_tsx.read_text()

old = '''        <button
          className={`tier-chip ${hideIsolated ? "on" : "off"}`}
          style={{ borderColor: "#a78bfa" }}
          onClick={() => setHideIsolated((v) => !v)}
          title="Hide chunk nodes that have NO edges (clearer viz)"
        >
          <span className="tier-dot" style={{ background: "#a78bfa" }} />
          Connected only
        </button>
        <div className="hud-divider" />'''

assert old in src, "Couldn't find stale chip"
src = src.replace(old, "")

app_tsx.write_text(src)
print(f"Removed: {len(src)} bytes")
print("Final hideIsolated refs:", src.count("hideIsolated"))