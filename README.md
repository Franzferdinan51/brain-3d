# 🧠 brain-3d

A 3D visualizer for [duckbot-rag-memory](https://github.com/Franzferdinan51/duckbot-rag-memory).

Read-only. Renders chunks (colored by tier) and entities in a Fibonacci-spiral sphere layout, so you can **see** your brain's shape.

![brain-3d screenshot](https://raw.githubusercontent.com/Franzferdinan51/brain-3d/main/docs/screenshot.png)

## What it does

- Reads `brain_export.md` + `graph.db` from a duckbot-rag-memory install
- Emits a single `public/brain-graph.json` (nodes + edges)
- React + `react-force-graph-3d` renders it as a 3D sphere
- HUD shows live tier counts, search, hover preview

## Why a sphere layout, not force-directed?

A vector-RAG stores similarity in 768-d embedding space, **not** as graph edges.
The brain has ~3,700 chunks with zero inter-chunk edges — only ~26 entities have
entity→entity relationships. Force-layout on that graph collapses into a giant
sphere under central gravity.

So brain-3d precomputes positions with a deterministic **Fibonacci spiral** and
disables the d3-force simulation entirely (`cooldownTicks={0}`, `warmupTicks={0}`,
`d3AlphaMin={0}`). Result: every node has a stable, distributed position.

## Setup

```bash
# 1. Clone
git clone https://github.com/Franzferdinan51/brain-3d
cd brain-3d

# 2. Install
npm install

# 3. Generate brain-graph.json from your brain
python3 scripts/build-graph-json.py /path/to/duckbot-rag-memory/data
# → writes public/brain-graph.json

# 4. Run
npm run dev -- --host 127.0.0.1 --port 5173
```

Then open <http://127.0.0.1:5173/>.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/build-graph-json.py` | Parse brain_export.md + graph.db → `public/brain-graph.json` |

## Architecture

- **No backend** — pure static SPA, the brain is read once at build time
- **`react-force-graph-3d` v1.29.1** wrapped in workarounds (cooldownTicks/warmupTicks = 0)
- **No force simulation** — positions are deterministic, no animation jank
- **HUD overlay** is plain CSS, no chart lib

## Known issues

- First-frame TypeError in console (`Cannot read properties of undefined (reading 'tick')`) — **non-fatal**, library recovers on frame 2
- Spheres are slightly large; reduce `nodeVal` if you want smaller dots
- No interactivity with click → only copies chunk ID to clipboard

## License

MIT — see `LICENSE`.