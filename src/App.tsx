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
  const [selected, setSelected] = useState<GraphNode | null>(null);
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

  // Filter nodes by tier + entities + search
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
    });
    // Only keep links whose endpoints are in the filtered set
    const keepIds = new Set(nodes.map((n) => n.id));
    const links = graph.links.filter(
      (l) => keepIds.has(typeof l.source === "string" ? l.source : (l.source as any).id)
        && keepIds.has(typeof l.target === "string" ? l.target : (l.target as any).id),
    );
    return { nodes, links };
  }, [graph, activeTiers, showEntities, search]);

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
    chunks.forEach((c, i) => {
      const r = 120 + (i / Math.max(N, 1)) * 30;        // shell radius by rank
      const y = 1 - (i / Math.max(N - 1, 1)) * 2;       // -1..1
      const rad = Math.sqrt(1 - y * y);
      const theta = phi * i;
      (c as any).fx = Math.cos(theta) * rad * r;
      (c as any).fy = y * r;
      (c as any).fz = Math.sin(theta) * rad * r;
    });
    ents.forEach((e, i) => {
      const ang = (i / Math.max(ents.length, 1)) * Math.PI * 2;
      (e as any).fx = Math.cos(ang) * 25;
      (e as any).fy = 0;
      (e as any).fz = Math.sin(ang) * 25;
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
        }}
        cooldownTicks={0}
        warmupTicks={0}
        d3AlphaMin={0}
        enableNodeDrag={false}
        enablePointerInteraction
        showNavInfo={false}
      />

      {/* bottom-right: hover or selected-node panel */}
      <div className="hud hud-br">
        {selected ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className="hover-tier" style={{ color: selected.color }}>
                {selected.kind === "entity"
                  ? `🏷️ ${ENTITY_LABEL[(selected as EntityNode).entityKind] ?? "Entity"} · ${selected.name}`
                  : `${TIER_LABEL[(selected as ChunkNode).tier] ?? (selected as ChunkNode).tier} · importance ${(selected as ChunkNode).importance.toFixed(2)}`}
              </div>
              <button
                onClick={() => setSelected(null)}
                style={{ background: "transparent", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: "1rem", padding: 0 }}
                title="close"
              >×</button>
            </div>
            <div className="hover-id">{selected.id}</div>
            <div className="hover-src">{selected.source || "—"}</div>
            <div className="hover-preview">{selected.preview}</div>
            <div className="hud-divider" />
            <div className="hud-foot">
              <b>{neighbors.length}</b> neighbor{neighbors.length === 1 ? "" : "s"}
            </div>
            {neighbors.map(({ node, edge, sim }) => (
              <div
                key={node.id}
                onClick={() => setSelected(node)}
                style={{
                  borderLeft: `2px solid ${node.color}`,
                  padding: "4px 8px",
                  marginTop: 4,
                  cursor: "pointer",
                  background: "rgba(255,255,255,0.02)",
                  borderRadius: 3,
                  fontSize: "0.7rem",
                  fontFamily: "var(--font-mono)",
                  lineHeight: 1.4,
                }}
                title={node.preview}
              >
                <span style={{ color: node.color }}>
                  {node.kind === "entity" ? "🏷️ " : ""}{node.name}
                </span>
                {" "}
                <span style={{ opacity: 0.6 }}>
                  {edge.label || edge.kind}
                </span>
              </div>
            ))}
          </>
        ) : hover ? (
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
              <em>click to inspect neighbors</em>
            </div>
          </>
        ) : (
          <div className="hover-empty">hover a node · click to recall</div>
        )}
      </div>
    </div>
  );
}