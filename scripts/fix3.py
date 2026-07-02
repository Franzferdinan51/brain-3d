#!/usr/bin/env python3
"""Remove leftover Connected only chip + all hideIsolated references."""
from pathlib import Path
import re

p = Path("/Users/duckets/Desktop/brain-3d/src/App.tsx")
src = p.read_text()

# 1. Delete the chip block (literal multiline match)
chip_pattern = '''        <button
          className={`tier-chip ${hideIsolated ? "on" : "off"}`}
          style={{ borderColor: "#a78bfa" }}
          onClick={() => setHideIsolated((v) => !v)}
          title="Hide chunk nodes that have NO edges (clearer viz)"
        >
          <span className="tier-dot" style={{ background: "#a78bfa" }} />
          Connected only
        </button>
'''
if chip_pattern in src:
    src = src.replace(chip_pattern, "")
    print("Removed chip block")
else:
    print("Chip block NOT found")

# 2. Should be no remaining references — confirm
remaining = src.count("hideIsolated")
print(f"Remaining hideIsolated refs: {remaining}")
if remaining > 0:
    # Find and show them
    for i, line in enumerate(src.split("\n")):
        if "hideIsolated" in line:
            print(f"  Line {i+1}: {line.strip()}")

p.write_text(src)
print(f"Wrote: {len(src)} bytes")