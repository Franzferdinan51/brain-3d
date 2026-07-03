#!/usr/bin/env python3
"""
One-shot patch to fix the brain-3d click bug:
- Make non-episodic chunk nodes larger so they protrude through the episodic ball
"""
import sys
from pathlib import Path

path = Path("/Users/duckets/Desktop/brain-3d/src/App.tsx")
src = path.read_text()

OLD_VAL = '        nodeVal={(n: any) => n.val}'
NEW_VAL = '''        nodeVal={(n: any) => {
          // Boost non-episodic node sizes so they protrude through the
          // episodic sphere. Without this, working/procedural/semantic
          // nodes are hidden inside the dense episodic ball and clicks
          // on the front-facing episodic surface never reach them.
          const base = (n.val || 1) * 4;
          if (n.kind === "entity") return base * 1.4;
          if (n.tier === "working") return base * 1.2;
          if (n.tier === "procedural") return base * 1.1;
          if (n.tier === "semantic") return base * 1.0;
          return n.val || 1;  // episodic — unchanged
        }}'''

if OLD_VAL not in src:
    print("ERROR: nodeVal line not found verbatim. Aborting.")
    sys.exit(1)

new = src.replace(OLD_VAL, NEW_VAL)
path.write_text(new)
print(f"OK Patched {path}")
print(f"  old: {OLD_VAL!r}")
print(f"  new (first 120 chars): {NEW_VAL[:120]!r}")