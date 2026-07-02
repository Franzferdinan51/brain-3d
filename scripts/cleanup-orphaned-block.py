#!/usr/bin/env python3
"""Remove orphaned hideIsolated block from filtered useMemo."""
from pathlib import Path

app_tsx = Path("/Users/duckets/Desktop/brain-3d/src/App.tsx")
src = app_tsx.read_text()

old = '''    // Only keep links whose endpoints are in the filtered set
    const keepIds = new Set(nodes.map((n) => n.id));
    const links = graph.links.filter(
      (l) => keepIds.has(typeof l.source === "string" ? l.source : (l.source as any).id)
        && keepIds.has(typeof l.target === "string" ? l.target : (l.target as any).id),
    );
    // Hide-isolated: drop chunk nodes that have no edges (entity nodes always kept)
    let connectedIds = keepIds;
    if (hideIsolated) {
      connectedIds = new Set<string>();
      for (const l of links) {
        const sid = typeof l.source === "string" ? l.source : (l.source as any).id;
        const tid = typeof l.target === "string" ? l.target : (l.target as any).id;
        connectedIds.add(sid);
        connectedIds.add(tid);
      }
      // always keep entity nodes
      for (const n of nodes) if (n.kind === "entity") connectedIds.add(n.id);
    }
    const finalNodes = nodes.filter((n) => connectedIds.has(n.id));
    const finalLinks = links.filter(
      (l) => connectedIds.has(typeof l.source === "string" ? l.source : (l.source as any).id)
        && connectedIds.has(typeof l.target === "string" ? l.target : (l.target as any).id),
    );
    return { nodes: finalNodes, links: finalLinks };
  }, [graph, activeTiers, showEntities, search, hideIsolated]);'''

new = '''    // Only keep links whose endpoints are in the filtered set
    const keepIds = new Set(nodes.map((n) => n.id));
    const links = graph.links.filter(
      (l) => keepIds.has(typeof l.source === "string" ? l.source : (l.source as any).id)
        && keepIds.has(typeof l.target === "string" ? l.target : (l.target as any).id),
    );
    return { nodes, links };
  }, [graph, activeTiers, showEntities, search, viewMode]);'''

assert old in src, "Couldn't find orphaned block"
src = src.replace(old, new)

# Remove the orphaned "Connected only" chip from HUD too
old_chip = '''        <button
          className={`tier-chip ${hideIsolated ? "on" : "off"}`}
          style={{ borderColor: "#a855f7" }}
          onClick={() => setHideIsolated((v) => !v)}
        >
          <span className="tier-dot" style={{ background: "#a855f7" }} />
          Connected only <span className="tier-count">{(filtered?.nodes.length ?? 0).toLocaleString()}</span>
        </button>'''
if old_chip in src:
    src = src.replace(old_chip, "")

app_tsx.write_text(src)
print(f"Cleaned: {len(src)} bytes")