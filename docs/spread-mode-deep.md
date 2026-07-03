# Spread Mode — Dramatic Edition

Added in commit `37b3b49`. Enables real cluster formation in Spread layout mode.

## What's different

**Before:** Spread mode showed a near-spherical shape because:
- graph.json had only 662 similarity edges (knn=1)
- That gave each chunk ~0.4 edges on average
- Force-physics with sparse edges produces uniform repulsion → ball shape

**After:** 
- graph.json has 8,828 similarity edges (knn=5, threshold 0.80)
- Each chunk has ~5.5 edges on average
- Force-physics + dense similarity graph produces visible clusters

## Tuning

| Knob | Before | After | Why |
|------|--------|-------|-----|
| knn_k | 1 | 5 | more edges per chunk → more attraction force |
| min_similarity | 0.90 | 0.80 | more edges per chunk → more attraction force |
| charge strength | -30 (default) | -25 | less repulsion → edges can win |
| link distance | 30 (default) | 35 | edges pull slightly harder |

## How to rebuild for your brain

```bash
python scripts/build-graph-json.py \
  --chroma /Users/duckets/Desktop/duckbot-rag-memory/data/chroma \
  --chroma-collections duckbot_episodic \
  --knn-k 5 --min-similarity 0.80 \
  --out public/brain-graph.json
```

The launcher plist (`/Users/duckets/Library/LaunchAgents/com.brain3d.rebuild-watcher.plist`) now has `REBUILD_KNN_K=5` and `REBUILD_MIN_SIMILARITY=0.80` set so the watcher auto-rebuilds with these settings.

## URL deep-links

- `?display=3d&spread=1` — Connect view + Spread layout
- `?display=3d` — Connect view + Sphere layout (default)
- `?display=kanban` — kanban view
- `?view=all&spread=1` — All nodes + Spread
- `?view=entities` — just the 23-entity graph
