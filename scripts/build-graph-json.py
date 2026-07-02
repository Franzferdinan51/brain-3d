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
import os
import re
import sqlite3
import sys
from pathlib import Path
from typing import Iterable

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


def knn_edges_from_chroma(
    chunks: list[dict],
    chroma_path: Path,
    collections: Iterable[str],
    top_k: int = 3,
    min_similarity: float = 0.5,
    lmstudio_url: str = "http://127.0.0.1:1234/v1",
    lmstudio_key: str | None = None,
    embed_model: str = "text-embedding-nomic-embed-text-v1.5",
    embed_dim: int = 768,
) -> list[dict]:
    """For each chunk, find the top-K most similar chunks via ChromaDB query.

    This gives real semantic edges: chunks about 'safety wrapper rule' will
    connect to other safety-wrapper chunks. The brain becomes a real graph
    instead of a sphere-shell.

    Strategy:
      1. Use LM Studio's /v1/embeddings endpoint to compute 768-dim query
         vectors (matches the dimension used at ingestion time — LMSTUDIO_EMBED_DIM=768
         in duckbot-rag-memory/.env)
      2. Query ChromaDB via `query_embeddings=[vec]` so we don't trigger
         ChromaDB's default 384-dim embedding function
      3. ChromaDB returns cosine distances; similarity = 1 - distance

    Cost: ~30 seconds for 526 chunks × 4 collections on a typical Mac.
    Output: ~N×K edges, filtered to similarity >= min_similarity.
    """
    try:
        import chromadb  # noqa: F401
        import httpx
    except ImportError as e:
        print(f"⚠️  missing dep: {e}; pip install chromadb httpx", file=sys.stderr)
        return []

    if not chroma_path.exists():
        print(f"⚠️  chroma path not found: {chroma_path}", file=sys.stderr)
        return []

    print(f"🔗 opening ChromaDB at {chroma_path} …")
    client = chromadb.PersistentClient(path=str(chroma_path))

    # Load LM Studio key from .env if present
    if lmstudio_key is None:
        env_path = Path(__file__).parent.parent / ".env"
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if line.startswith("LMSTUDIO_API_KEY="):
                    lmstudio_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break

    if lmstudio_key is None:
        lmstudio_key = os.environ.get("LMSTUDIO_API_KEY", "")

    chunk_ids = {c["id"] for c in chunks}

    # Cache embeddings keyed by chunk id (so chunks shared across collections
    # don't get re-embedded)
    embed_cache: dict[str, list[float]] = {}

    def embed_text(text: str) -> list[float] | None:
        """Hit LM Studio /v1/embeddings, return a 768-dim vector."""
        try:
            headers = {"Content-Type": "application/json"}
            if lmstudio_key:
                headers["Authorization"] = f"Bearer {lmstudio_key}"
            r = httpx.post(
                f"{lmstudio_url.rstrip('/')}/embeddings",
                headers=headers,
                json={"model": embed_model, "input": text[:1024]},
                timeout=30.0,
            )
            r.raise_for_status()
            data = r.json()
            vec = data["data"][0]["embedding"]
            if len(vec) != embed_dim:
                print(f"   ⚠️  dim mismatch: got {len(vec)}, expected {embed_dim}",
                      file=sys.stderr)
            return vec
        except Exception as e:
            print(f"   ⚠️  embed error: {e}", file=sys.stderr)
            return None

    edges: list[dict] = []
    seen_pairs: set[tuple[str, str]] = set()
    coll_stats: dict[str, int] = {}

    for coll_name in collections:
        try:
            coll = client.get_collection(coll_name)
        except Exception as e:
            print(f"   ⚠️  skip collection '{coll_name}': {e}")
            continue
        count = coll.count()
        print(f"   '{coll_name}': {count:,} embeddings, querying {len(chunks):,} chunks…")

        coll_edges = 0
        for i, chunk in enumerate(chunks):
            cid = chunk["id"]
            query_text = chunk["text"][:512]
            if not query_text.strip():
                continue

            # Cache embeddings by chunk id
            if cid in embed_cache:
                vec = embed_cache[cid]
            else:
                vec = embed_text(query_text)
                if vec is None:
                    continue
                embed_cache[cid] = vec

            try:
                results = coll.query(
                    query_embeddings=[vec],
                    n_results=top_k + 1,  # +1 because self is included
                )
            except Exception as e:
                continue

            ids = (results.get("ids") or [[]])[0]
            distances = (results.get("distances") or [[]])[0]
            for nid, ndist in zip(ids, distances):
                if nid == cid:
                    continue
                if nid not in chunk_ids:
                    continue
                similarity = max(0.0, 1.0 - float(ndist))
                if similarity < min_similarity:
                    continue
                pair = tuple(sorted([cid, nid]))
                if pair in seen_pairs:
                    continue
                seen_pairs.add(pair)
                edges.append({
                    "source": f"chunk:{pair[0]}",
                    "target": f"chunk:{pair[1]}",
                    "label": f"sim {similarity:.2f}",
                    "kind": "similarity-edge",
                    "color": _similarity_color(similarity),
                })
                coll_edges += 1

            if (i + 1) % 100 == 0:
                print(f"      {i + 1}/{len(chunks)} chunks queried, "
                      f"{coll_edges} edges so far…", flush=True)

        coll_stats[coll_name] = coll_edges
        print(f"      → {coll_edges} edges from {coll_name}")

    print(f"   ✨ {len(edges):,} unique similarity edges (>= {min_similarity})")
    return edges


def _similarity_color(sim: float) -> str:
    """Map similarity in [0,1] to a hot-cyan alpha."""
    # 0.5 → very faint, 0.9 → bright cyan
    alpha = min(0.9, max(0.08, (sim - 0.5) * 1.6))
    return f"rgba(34, 211, 238, {alpha:.2f})"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", required=True, type=Path)
    ap.add_argument("--graph", type=Path, default=None,
                    help="Path to graph.db (optional)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--max-nodes", type=int, default=0)
    ap.add_argument("--chroma", type=Path, default=None,
                    help="Path to duckbot-rag-memory/data/chroma (optional)")
    ap.add_argument("--chroma-collections", nargs="+",
                    default=["duckbot_semantic", "duckbot_episodic",
                             "duckbot_procedural", "duckbot_working"],
                    help="ChromaDB collection names to query")
    ap.add_argument("--knn-k", type=int, default=3,
                    help="Top-K similar chunks per chunk (default: 3)")
    ap.add_argument("--min-similarity", type=float, default=0.5,
                    help="Minimum cosine similarity for an edge (default: 0.5)")
    ap.add_argument("--lmstudio-url", default="http://127.0.0.1:1234/v1",
                    help="LM Studio /v1 endpoint (default: http://127.0.0.1:1234/v1)")
    ap.add_argument("--lmstudio-key", default=None,
                    help="Bearer token (or read LMSTUDIO_API_KEY env)")
    ap.add_argument("--embed-model", default="text-embedding-nomic-embed-text-v1.5",
                    help="Embedding model name (default: nomic-embed-text-v1.5)")
    ap.add_argument("--embed-dim", type=int, default=768,
                    help="Embedding dim (default: 768)")
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

    # k-NN similarity edges via ChromaDB (adds real semantic edges)
    if args.chroma:
        knn = knn_edges_from_chroma(
            chunks, args.chroma, args.chroma_collections,
            top_k=args.knn_k, min_similarity=args.min_similarity,
            lmstudio_url=args.lmstudio_url,
            lmstudio_key=args.lmstudio_key,
            embed_model=args.embed_model,
            embed_dim=args.embed_dim,
        )
        graph["links"].extend(knn)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as f:
        json.dump(graph, f, separators=(",", ":"))

    size_mb = args.out.stat().st_size / (1024 * 1024)
    sim_count = sum(1 for l in graph["links"] if l.get("kind") == "similarity-edge")
    print(f"✅ wrote {args.out} ({size_mb:.1f} MB, "
          f"{len(graph['nodes']):,} nodes, {len(graph['links']):,} links, "
          f"{sim_count:,} similarity edges)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())