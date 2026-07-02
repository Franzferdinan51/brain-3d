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
        linkWidth={0.5}
        linkLabel={(l: any) => l.label ? `label: ${l.label}` : ""}
        onNodeHover={(n: any) => setHover(n as GraphNode | null)}
        onNodeClick={(n: any) => {
          navigator.clipboard?.writeText(n.id).catch(() => {});
          alert(
            `${n.kind === "entity" ? "Entity" : "Chunk"}: ${n.id}\n\n` +
            `Copied to clipboard.\n\nRun in Brain:\n` +
            `brain_inspect(entity="${n.kind === "entity" ? n.name : n.id.slice(0, 12)}")`,
          );
        }}
        cooldownTicks={0}
        warmupTicks={0}
        d3AlphaMin={0}
        enableNodeDrag={false}
        enablePointerInteraction
        showNavInfo={false}
      />

      {/* hover footer */}
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
          </>
        ) : (
          <div className="hover-empty">hover a node · click to recall</div>
        )}
      </div>
    </div>
  );
}