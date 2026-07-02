#!/usr/bin/env python3
"""
build-graph-json.py — convert duckbot-rag-memory's brain_export.md AND
graph.db into a graph-JSON consumable by brain-3d (the read-only visualizer).

This script lives in brain-3d, NOT in duckbot-rag-memory. It only READS the
brain's nightly export + graph.db and writes a JSON file into
brain-3d/public/. Duckets' directive (2026-07-02): "so that we don't mess
with the brain".

Two layers are emitted:
  - Chunks (3,700+ nodes): tier-colored, sized by importance, scattered
  - Entities (20+ nodes): knowledge-graph entities from graph.db, larger
  - Entity→entity links: from graph.db relationships table

Usage:
    python3 scripts/build-graph-json.py \
        --export ~/Desktop/duckbot-rag-memory/data/brain_export.md \
        --graph  ~/Desktop/duckbot-rag-memory/data/graph.db \
        --out    ~/Desktop/brain-3d/public/brain-graph.json
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

# Tier → color (rgba hex)
TIER_COLOR = {
    "working":    "#f59e0b",  # amber
    "episodic":   "#3b82f6",  # blue
    "semantic":   "#a855f7",  # purple
    "procedural": "#10b981",  # emerald
}

ENTITY_COLOR_BY_KIND = {
    "person":   "#fb7185",  # rose
    "project":  "#f59e0b",  # amber (matches 'working' but gold stands out)
    "place":    "#22d3ee",  # cyan
    "concept":  "#a855f7",  # purple (matches 'semantic')
    "fact":     "#facc15",  # yellow
    "file":     "#94a3b8",  # slate
}

# Heading `### <id>  (tier=X, importance=Y)`
CHUNK_RE = re.compile(r"^### ([0-9a-f-]+)\s+\(tier=(\w+),\s*importance=([\d.]+)\)")
# Body line `_source: ...`
SOURCE_RE = re.compile(r"^_source:\s*(.+?)\s*_?\s*$")


def parse_export(export_path: Path) -> list[dict]:
    chunks: list[dict] = []
    current: dict | None = None

    with export_path.open("r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.rstrip("\n")

            if line.startswith("## "):
                heading = line[3:].strip().lower()
                if heading in TIER_COLOR:
                    # tier is set per-chunk via regex, no need to track
                    pass
                continue

            m = CHUNK_RE.match(line)
            if m:
                if current is not None:
                    chunks.append(current)
                current = {
                    "id": m.group(1),
                    "tier": m.group(2),
                    "importance": float(m.group(3)),
                    "source": "",
                    "text": "",
                }
                continue

            if current is None:
                continue

            sm = SOURCE_RE.match(line.strip())
            if sm and not current["source"]:
                current["source"] = sm.group(1).strip()
                continue

            stripped = line.strip()
            if stripped:
                if current["text"]:
                    current["text"] += " "
                current["text"] += stripped

    if current is not None:
        chunks.append(current)

    return chunks


def chunks_to_nodes(chunks: list[dict]) -> list[dict]:
    nodes: list[dict] = []
    for c in chunks:
        text = c["text"]
        preview = text[:200] + ("…" if len(text) > 200 else "")
        nodes.append({
            "id": f"chunk:{c['id']}",
            "kind": "chunk",
            "name": c["id"][:12],
            "tier": c["tier"],
            "color": TIER_COLOR.get(c["tier"], "#94a3b8"),
            "importance": c["importance"],
            "source": c["source"],
            "val": max(0.5, min(c["importance"] * 2.5, 12)),
            "preview": preview,
        })
    return nodes


def load_graph_db(graph_db_path: Path) -> tuple[list[dict], list[dict]]:
    """Returns (entity_nodes, relationship_links)."""
    if not graph_db_path.exists():
        return [], []
    conn = sqlite3.connect(f"file:{graph_db_path}?mode=ro", uri=True)
    try:
        cur = conn.cursor()
        cur.execute("SELECT id, name, kind FROM entities")
        entity_rows = cur.fetchall()
        cur.execute(
            "SELECT source_id, target_id, label "
            "FROM relationships "
            "WHERE valid_until IS NULL"  # only currently-valid edges
        )
        rel_rows = cur.fetchall()
    finally:
        conn.close()

    entity_nodes = []
    for eid, name, kind in entity_rows:
        entity_nodes.append({
            "id": f"entity:{eid}",
            "kind": "entity",
            "name": name,
            "entityKind": kind,
            "color": ENTITY_COLOR_BY_KIND.get(kind, "#94a3b8"),
            "importance": 5.0,  # entities are always prominent
            "source": f"graph.db#{kind}",
            "val": 18,
            "preview": f"Knowledge-graph entity: {name} ({kind})",
        })

    links = []
    seen = set()
    for src, tgt, label in rel_rows:
        key = (src, tgt, label)
        if key in seen:
            continue
        seen.add(key)
        links.append({
            "source": f"entity:{src}",
            "target": f"entity:{tgt}",
            "label": label,
            "kind": "entity-edge",
            "color": "rgba(148,163,184,0.6)",
        })

    return entity_nodes, links


def to_graph(chunks: list[dict], graph_db: Path | None) -> dict:
    nodes = chunks_to_nodes(chunks)
    links: list[dict] = []

    if graph_db:
        ent_nodes, ent_links = load_graph_db(graph_db)
        nodes.extend(ent_nodes)
        links.extend(ent_links)

    return {"nodes": nodes, "links": links}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", required=True, type=Path)
    ap.add_argument("--graph", type=Path, default=None,
                    help="Path to graph.db (optional)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--max-nodes", type=int, default=0)
    args = ap.parse_args()

    if not args.export.exists():
        print(f"❌ export not found: {args.export}", file=sys.stderr)
        return 2

    print(f"📖 reading {args.export} …")
    chunks = parse_export(args.export)
    print(f"   parsed {len(chunks):,} chunks")

    by_tier: dict[str, int] = {}
    for c in chunks:
        by_tier[c["tier"]] = by_tier.get(c["tier"], 0) + 1
    for tier, n in sorted(by_tier.items()):
        print(f"   {tier:11s} {n:>5,}")

    if args.max_nodes and len(chunks) > args.max_nodes:
        chunks = sorted(chunks, key=lambda c: c["importance"], reverse=True)[: args.max_nodes]
        print(f"✂️  capped to top-{args.max_nodes} chunks by importance")

    graph = to_graph(chunks, args.graph)
    if args.graph:
        ent_count = sum(1 for n in graph["nodes"] if n.get("kind") == "entity")
        ent_edge_count = sum(1 for l in graph["links"] if l.get("kind") == "entity-edge")
        print(f"   + {ent_count} entities, {ent_edge_count} relationships from graph.db")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as f:
        json.dump(graph, f, separators=(",", ":"))

    size_mb = args.out.stat().st_size / (1024 * 1024)
    print(f"✅ wrote {args.out} ({size_mb:.1f} MB, "
          f"{len(graph['nodes']):,} nodes, {len(graph['links']):,} links)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())