#!/usr/bin/env python3
"""Add 'View' segmented control to App.tsx — Connected / All / Graph."""
from pathlib import Path

app_tsx = Path("/Users/duckets/Desktop/brain-3d/src/App.tsx")
src = app_tsx.read_text()

# 1. Add viewMode state after search useState
old = 'const [search, setSearch] = useState("");'
new = 'const [search, setSearch] = useState("");\n  const [viewMode, setViewMode] = useState<"all" | "connected" | "entities">("connected");'
assert old in src
src = src.replace(old, new)

# 2. Remove old hideIsolated state (was used for the now-deprecated toggle)
old = 'const [hideIsolated, setHideIsolated] = useState(true);'
assert old in src
src = src.replace(old, "")

# 3. Replace filtered useMemo body with viewMode-aware version
old = '''  // Filter nodes by tier + entities + search + hide-isolated
  const filtered = useMemo(() => {
    if (!graph) return null;
    const q = search.trim().toLowerCase();
    const nodes = graph.nodes.filter((n) => {
      const isEntity = n.kind === "entity";
      if (isEntity && !showEntities) return false;
      if (!isEntity) {
        const cn = n as ChunkNode;
        if (!activeTiers.has(cn.tier)) return false;
      }
      if (q === "") return true;
      return (
        n.preview.toLowerCase().includes(q) ||
        n.source.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q) ||
        n.name.toLowerCase().includes(q)
      );
    });'''
new = '''  // Filter nodes by tier + entities + search + viewMode
  const filtered = useMemo(() => {
    if (!graph) return null;
    const q = search.trim().toLowerCase();
    // First apply tier/entity toggle
    let nodes = graph.nodes.filter((n) => {
      const isEntity = n.kind === "entity";
      if (isEntity && !showEntities) return false;
      if (!isEntity) {
        const cn = n as ChunkNode;
        if (!activeTiers.has(cn.tier)) return false;
      }
      return true;
    });
    // ViewMode: entities-only → keep just entities
    if (viewMode === "entities") {
      nodes = nodes.filter((n) => n.kind === "entity");
    } else if (viewMode === "connected") {
      // Drop chunk nodes that have no edges (isolated chunks pile into a ball)
      const keepIds = new Set<string>();
      for (const l of graph.links) {
        const s = typeof l.source === "string" ? l.source : (l.source as any).id;
        const t = typeof l.target === "string" ? l.target : (l.target as any).id;
        keepIds.add(s); keepIds.add(t);
      }
      nodes = nodes.filter((n) => n.kind === "entity" || keepIds.has(n.id));
    }
    // Search
    if (q !== "") {
      nodes = nodes.filter((n) =>
        n.preview.toLowerCase().includes(q) ||
        n.source.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q) ||
        n.name.toLowerCase().includes(q)
      );
    }'''
assert old in src, "Couldn't find filtered useMemo block"
src = src.replace(old, new)

# 4. Add 3-way segmented control after Entities chip
old = '''        <button
          className={`tier-chip ${showEntities ? "on" : "off"}`}
          style={{ borderColor: "#fb7185" }}
          onClick={() => setShowEntities((v) => !v)}
        >
          <span className="tier-dot" style={{ background: "#fb7185" }} />
          Entities <span className="tier-count">{stats.entities.toLocaleString()}</span>
        </button>'''
new = '''        <button
          className={`tier-chip ${showEntities ? "on" : "off"}`}
          style={{ borderColor: "#fb7185" }}
          onClick={() => setShowEntities((v) => !v)}
        >
          <span className="tier-dot" style={{ background: "#fb7185" }} />
          Entities <span className="tier-count">{stats.entities.toLocaleString()}</span>
        </button>
        <div className="hud-divider" />
        <div className="view-mode-row">
          <span className="view-mode-label">View</span>
          <div className="segmented">
            <button
              className={`seg ${viewMode === "connected" ? "on" : ""}`}
              onClick={() => setViewMode("connected")}
              title="Chunks with edges + all entities (recommended)"
            >
              Connected
            </button>
            <button
              className={`seg ${viewMode === "all" ? "on" : ""}`}
              onClick={() => setViewMode("all")}
              title="Everything, no filter"
            >
              All
            </button>
            <button
              className={`seg ${viewMode === "entities" ? "on" : ""}`}
              onClick={() => setViewMode("entities")}
              title="23-entity knowledge graph only"
            >
              Graph
            </button>
          </div>
        </div>'''
assert old in src, "Couldn't find Entities chip"
src = src.replace(old, new)

app_tsx.write_text(src)
print(f"Patched {app_tsx}: {len(src)} bytes")