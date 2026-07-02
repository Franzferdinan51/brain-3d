import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import "./App.css";

// Shape matches what build-graph-json.py emits
type NodeBase = {
  id: string;
  name: string;
  color: string;
  importance: number;
  source: string;
  val: number;
  preview: string;
  text?: string;  // full chunk content (from brain_export.md); entities don't have it
};

type ChunkNode = NodeBase & {
  kind: "chunk";
  tier: "working" | "episodic" | "semantic" | "procedural" | string;
};

type EntityNode = NodeBase & {
  kind: "entity";
  entityKind: string;
};

type GraphNode = ChunkNode | EntityNode;

type Link = {
  source: string;
  target: string;
  label?: string;
  kind?: string;
  color?: string;
};

type Graph = { nodes: GraphNode[]; links: Link[] };

const TIER_LABEL: Record<string, string> = {
  working: "Working",
  episodic: "Episodic",
  semantic: "Semantic",
  procedural: "Procedural",
};

const TIER_BADGE: Record<string, string> = {
  working: "#f59e0b",
  episodic: "#3b82f6",
  semantic: "#a855f7",
  procedural: "#10b981",
};

const ENTITY_LABEL: Record<string, string> = {
  person: "Person",
  project: "Project",
  place: "Place",
  concept: "Concept",
  fact: "Fact",
  file: "File",
};

export default function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [activeTiers, setActiveTiers] = useState<Set<string>>(
    new Set(["working", "episodic", "semantic", "procedural"]),
  );
  const [showEntities, setShowEntities] = useState(true);
  const [hover, setHover] = useState<GraphNode | null>(null);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"all" | "connected" | "entities">("connected");
  const [selected, setSelected] = useState<GraphNode | null>(null);
  // Hide chunks that have no edges. Default ON because at 3,700+ chunks the
  // isolated ones pile into a dense sphere with no visible structure.
  
  const fgRef = useRef<any>(null);

  useEffect(() => {
    fetch("/brain-graph.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((g) => setGraph(g))
      .catch((e) => setErr(String(e)));
  }, []);

  // Auto-select from URL hash: open /index.html#chunk:abc123-0
  useEffect(() => {
    const tryHashSelect = () => {
      const id = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      if (!id) return;
      if (!graph) return false;
      const node = graph.nodes.find((n) => n.id === id || n.id.endsWith(id));
      if (node) {
        setSelected(node);
        return true;
      }
      return false;
    };
    const onHash = () => { tryHashSelect(); };
    window.addEventListener("hashchange", onHash);
    // Try now; if graph not ready, also try again whenever graph changes
    tryHashSelect();
    return () => window.removeEventListener("hashchange", onHash);
  }, [graph]);

  // When graph first arrives, also retry hash selection (covers initial load race)
  useEffect(() => {
    if (!graph) return;
    const id = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (!id || selected) return;
    const node = graph.nodes.find((n) => n.id === id || n.id.endsWith(id));
    if (node) setSelected(node);
  }, [graph]);

  // Esc to close the inspector
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected(null);
        window.history.replaceState(null, "", window.location.pathname);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  // Filter nodes by tier + entities + search + viewMode
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
    }
    // Only keep links whose endpoints are in the filtered set
    const keepIds = new Set(nodes.map((n) => n.id));
    const links = graph.links.filter(
      (l) => keepIds.has(typeof l.source === "string" ? l.source : (l.source as any).id)
        && keepIds.has(typeof l.target === "string" ? l.target : (l.target as any).id),
    );
    return { nodes, links };
  }, [graph, activeTiers, showEntities, search, viewMode]);

  const stats = useMemo(() => {
    if (!graph) return null;
    const byTier: Record<string, number> = {};
    let ent = 0;
    for (const n of graph.nodes) {
      if (n.kind === "entity") ent++;
      else byTier[(n as ChunkNode).tier] = (byTier[(n as ChunkNode).tier] ?? 0) + 1;
    }
    return { total: graph.nodes.length, byTier, entities: ent };
  }, [graph]);

  // Compute neighbors of `selected` node (any link where source or target matches)
const neighbors = useMemo(() => {
  if (!selected || !filtered) return [];
  const sid = selected.id;
  const out: { node: GraphNode; edge: Link; sim?: number }[] = [];
  const seenNodeIds = new Set<string>();
  for (const l of filtered.links) {
    const srcId = typeof l.source === "string" ? l.source : (l.source as any).id;
    const tgtId = typeof l.target === "string" ? l.target : (l.target as any).id;
    let otherId: string | null = null;
    if (srcId === sid) otherId = tgtId;
    else if (tgtId === sid) otherId = srcId;
    if (!otherId || seenNodeIds.has(otherId)) continue;
    const node = filtered.nodes.find((n) => n.id === otherId);
    if (!node) continue;
    seenNodeIds.add(otherId);
    let sim: number | undefined;
    if (l.kind === "similarity-edge" && l.label) {
      const m = l.label.match(/[\d.]+/);
      if (m) sim = parseFloat(m[0]);
    }
    out.push({ node, edge: l, sim });
  }
  // Sort: similarity edges first, by sim desc; then entity edges by label
  out.sort((a, b) => {
    if (a.sim !== undefined && b.sim !== undefined) return b.sim - a.sim;
    if (a.sim !== undefined) return -1;
    if (b.sim !== undefined) return 1;
    return (a.edge.label || "").localeCompare(b.edge.label || "");
  });
  return out.slice(0, 12);  // top 12 neighbors
}, [selected, filtered]);

const toggleTier = (t: string) => {
    setActiveTiers((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  };

  // Deterministic spiral layout for chunks (no force needed); force-layout for entities
  useEffect(() => {
    if (!graph) return;
    // Assign positions: chunks on a Fibonacci-spiral sphere shell;
    // entities clustered at the center with small jitter.
    const chunks = filtered?.nodes.filter((n) => n.kind !== "entity") ?? [];
    const ents   = filtered?.nodes.filter((n) => n.kind === "entity") ?? [];
    const N = chunks.length;
    const phi = Math.PI * (3 - Math.sqrt(5)); // golden angle
    // Adaptive radius: smaller when fewer chunks (so the graph stays compact on
    // its own), larger when many (still spread enough to read).
    const r = N < 200 ? 80 : N < 1000 ? 110 : 130;
    chunks.forEach((c, i) => {
      const y = 1 - (i / Math.max(N - 1, 1)) * 2;       // -1..1
      const rad = Math.sqrt(1 - y * y);
      const theta = phi * i;
      (c as any).fx = Math.cos(theta) * rad * r;
      (c as any).fy = y * r;
      (c as any).fz = Math.sin(theta) * rad * r;
    });
    ents.forEach((e, i) => {
      const ang = (i / Math.max(ents.length, 1)) * Math.PI * 2;
      (e as any).fx = Math.cos(ang) * 20;
      (e as any).fy = 0;
      (e as any).fz = Math.sin(ang) * 20;
    });
    if (fgRef.current) {
      (fgRef.current as any).d3ReheatSimulation?.();
      setTimeout(() => fgRef.current?.zoomToFit(600, 120), 600);
    }
  }, [filtered]);

  if (err) {
    return (
      <div className="error">
        <h1>❌ Could not load brain-graph.json</h1>
        <p>{err}</p>
        <p>Run <code>python3 scripts/build-graph-json.py</code> first.</p>
      </div>
    );
  }

  if (!filtered || !stats) {
    return <div className="loading">🧠 Loading brain…</div>;
  }

  return (
    <div className="app">
      {/* HUD top-left */}
      <div className="hud hud-tl">
        <div className="hud-title">🧠 Brain 3D</div>
        <div className="hud-sub">read-only visualizer for duckbot-rag-memory</div>
        <div className="hud-divider" />
        <div className="hud-stat">{stats.total.toLocaleString()} nodes</div>
        {Object.entries(stats.byTier).map(([t, n]) => (
          <button
            key={t}
            className={`tier-chip ${activeTiers.has(t) ? "on" : "off"}`}
            style={{ borderColor: TIER_BADGE[t] }}
            onClick={() => toggleTier(t)}
            title={`${activeTiers.has(t) ? "Hide" : "Show"} ${TIER_LABEL[t] ?? t}`}
          >
            <span className="tier-dot" style={{ background: TIER_BADGE[t] }} />
            {TIER_LABEL[t] ?? t} <span className="tier-count">{n.toLocaleString()}</span>
          </button>
        ))}
        <button
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
        </div>

        <input
          className="search"
          type="search"
          placeholder="search id / source / preview…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="hud-foot">
          showing <b>{filtered.nodes.length.toLocaleString()}</b> / {stats.total.toLocaleString()} nodes ·
          <b> {filtered.links.length.toLocaleString()}</b> edges
        </div>
      </div>

      {/* 3D graph */}
      <ForceGraph3D
        ref={fgRef}
        graphData={filtered}
        backgroundColor="#050810"
        nodeColor={(n: any) => n.color}
        nodeVal={(n: any) => n.val}
        nodeLabel={(n: any) =>
          `<div style="background:#0b1220;color:#e2e8f0;padding:8px 10px;border-radius:6px;border:1px solid #334155;font:11px/1.4 monospace;max-width:340px">
             <div style="color:${n.color};font-weight:600;margin-bottom:4px">${n.kind === "entity" ? "🏷️ " : ""}${n.kind} · ${n.id}</div>
             <div style="opacity:.7;margin-bottom:4px">${n.source || "—"}</div>
             <div>${(n.preview || "").replace(/[<>&]/g, "")}</div>
           </div>`
        }
        nodeOpacity={0.9}
        linkColor={(l: any) => l.color || "rgba(148,163,184,0.25)"}
        linkWidth={(l: any) => {
          // Similarity edges thicker for stronger relationships; entity edges fixed
          if (l.kind === "similarity-edge") {
            const sim = parseFloat((l.label || "").replace(/[^\d.]/g, "")) || 0.5;
            return 0.3 + (sim - 0.5) * 1.5;
          }
          return 0.8;  // entity edges a bit thicker
        }}
        linkDirectionalParticles={(l: any) =>
          l.kind === "similarity-edge" ? 1 : 0
        }
        linkDirectionalParticleWidth={1.5}
        linkDirectionalParticleColor={() => "rgba(34, 211, 238, 0.7)"}
        linkLabel={(l: any) => l.label ? `label: ${l.label}` : ""}
        onNodeHover={(n: any) => setHover(n as GraphNode | null)}
        onNodeClick={(n: any) => {
          setSelected(n as GraphNode);
          navigator.clipboard?.writeText(n.id).catch(() => {});
          // Update URL hash so the selection is shareable / bookmarkable
          window.history.replaceState(null, "", `#${n.id}`);
          // Camera focus: only if the node has a 3D position
          const dist = 220;
          const pos = (n.x !== undefined && n.y !== undefined && n.z !== undefined)
            ? { x: n.x, y: n.y, z: n.z }
            : null;
          if (pos) {
            fgRef.current?.cameraPosition(
              { x: pos.x + dist, y: pos.y + dist * 0.3, z: pos.z + dist },
              n,
              1200,
            );
          }
        }}
        cooldownTicks={0}
        warmupTicks={0}
        d3AlphaMin={0}
        enableNodeDrag={false}
        enablePointerInteraction
        showNavInfo={false}
        onBackgroundClick={() => {
          setSelected(null);
          window.history.replaceState(null, "", window.location.pathname);
        }}
      />

      {/* bottom-right: hover info */}
      <div className="hud hud-br">
        {hover ? (
          <>
            <div className="hover-tier" style={{ color: hover.color }}>
              {hover.kind === "entity"
                ? `🏷️ ${ENTITY_LABEL[(hover as EntityNode).entityKind] ?? "Entity"} · ${hover.name}`
                : `${TIER_LABEL[(hover as ChunkNode).tier] ?? (hover as ChunkNode).tier} · importance ${(hover as ChunkNode).importance.toFixed(2)}`}
            </div>
            <div className="hover-id">{hover.id}</div>
            <div className="hover-src">{hover.source || "—"}</div>
            <div className="hover-preview">{hover.preview}</div>
            <div className="hud-foot" style={{ marginTop: 8 }}>
              <em>click to inspect</em>
            </div>
          </>
        ) : (
          <div className="hover-empty">hover a node · click to inspect</div>
        )}
      </div>

      {/* Click-to-inspect modal: opens when a node is clicked.
          Shows full chunk text + clickable neighbors list. */}
      {selected && (
        <div
          className="inspector-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelected(null);
          }}
        >
          <div className="inspector">
            <div className="inspector-head">
              <div className="hover-tier" style={{ color: selected.color, fontSize: "1rem" }}>
                {selected.kind === "entity"
                  ? `🏷️ ${ENTITY_LABEL[(selected as EntityNode).entityKind] ?? "Entity"} · ${selected.name}`
                  : `${TIER_LABEL[(selected as ChunkNode).tier] ?? (selected as ChunkNode).tier} · importance ${(selected as ChunkNode).importance.toFixed(2)}`}
              </div>
              <button
                className="inspector-close"
                onClick={() => {
                  setSelected(null);
                  window.history.replaceState(null, "", window.location.pathname);
                }}
                title="close (esc)"
              >×</button>
            </div>

            <div className="inspector-meta">
              <div><b>id:</b> <code>{selected.id}</code></div>
              <div><b>source:</b> {selected.source || "—"}</div>
            </div>

            <div className="hud-divider" />

            {/* Full chunk text — what brain_recall would return for this id */}
            <div className="inspector-text">
              {selected.kind === "chunk" && selected.text ? (
                <>
                  <div className="inspector-section-label">FULL CONTENT ({selected.text.length.toLocaleString()} chars)</div>
                  <pre>{selected.text}</pre>
                </>
              ) : selected.kind === "entity" ? (
                <>
                  <div className="inspector-section-label">ENTITY</div>
                  <p style={{ color: "var(--text-dim)", fontStyle: "italic" }}>
                    Entities are nodes in the brain's knowledge graph.<br/>
                    They don't have raw chunk content — they're abstractions over multiple chunks.<br/>
                    Inspect neighbors below to see the chunks that touch this entity.
                  </p>
                </>
              ) : (
                <p style={{ color: "var(--text-dim)" }}>{selected.preview}</p>
              )}
            </div>

            <div className="hud-divider" />

            {/* Neighbors list — recursive drill-in */}
            <div className="inspector-neighbors">
              <div className="inspector-section-label">
                {neighbors.length} NEIGHBOR{neighbors.length === 1 ? "" : "S"}
              </div>
              {neighbors.length === 0 ? (
                <div className="inspector-empty">no edges — isolated node</div>
              ) : (
                neighbors.map(({ node, edge, sim }) => (
                  <div
                    key={node.id}
                    className="inspector-neighbor-row"
                    onClick={() => setSelected(node)}
                    title={node.preview}
                  >
                    <span className="inspector-neighbor-dot" style={{ background: node.color }} />
                    <span style={{ color: node.color, flex: 1 }}>
                      {node.kind === "entity" ? "🏷️ " : ""}{node.name}
                    </span>
                    <span className="inspector-neighbor-edge">
                      {edge.label || edge.kind || "edge"}
                    </span>
                    {sim !== undefined && (
                      <span className="inspector-neighbor-sim">{Math.round(sim * 100)}%</span>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="inspector-foot">
              press <kbd>esc</kbd> to close · click neighbor to drill in
            </div>
          </div>
        </div>
      )}
    </div>
  );
}