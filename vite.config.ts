import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ============================================================================
// Pluggable task-source registry (2026-07-02 22:45 EDT)
//
// Duckets' stack is multi-agent (Hermes Windows, PocketDuck Windows,
// AgentSmith Android/Termux, OpenClaw current). The kanban should read
// from whichever agent is *currently connected*, not be hardcoded to one.
//
// We model this as a SOURCE REGISTRY: each driver knows how to read tasks
// from one storage backend and expose them in a common shape. The plugin
// picks the active driver based on:
//   1. ?source=X query param (manual override for testing)
//   2. OpenClaw session key / env hint (auto-detect)
//   3. Falls back to "hermes-sqlite" (canonical, always-on)
//
// Drivers are read-only for now — writes still go through Hermes CLI
// (canonical store). Adding a 2nd writer is a future-PR concern.
//
// Our 4-column view mapping:
//   todo    ← triage/todo/ready/scheduled (universal)
//   doing   ← running
//   failed  ← blocked
//   done    ← done/archived
// ============================================================================

const ACTIVE_AGENT_HINT = process.env.DUCKBOT_ACTIVE_AGENT ||
  process.env.OPENCLAW_AGENT ||
  process.env.HERMES_ASSIGNEE ||
  null;

const HERMES_DB = path.join(os.homedir(), '.hermes', 'kanban.db');
const HERMES_CLI = path.join(os.homedir(), '.local', 'bin', 'hermes');
const DUCKBOT_JSON = path.join(os.homedir(), '.openclaw', 'workspace', 'state', 'kanban.json');

// ---------- Helpers ----------

function mapUniversalStatus(s: string): string {
  switch ((s || '').toLowerCase()) {
    case 'triage':
    case 'todo':
    case 'ready':
    case 'scheduled':
      return 'todo';
    case 'running':
    case 'in_progress':
    case 'doing':
      return 'doing';
    case 'blocked':
      return 'failed';
    case 'done':
    case 'completed':
    case 'archived':
      return 'done';
    default:
      return 'todo';
  }
}

function nowIso() { return new Date().toISOString(); }

// ---------- Source drivers ----------

interface KanbanTask {
  id: string;
  title: string;
  status: string;
  raw_status?: string;
  source: string;           // which driver produced this row
  note?: string;
  created?: string;
  updated?: string;
  assignee?: string;
  meta?: Record<string, unknown>;
}

interface KanbanState {
  tasks: KanbanTask[];
  updated: string;
  counts?: Record<string, number>;
  source: string;           // driver id that produced this
  sources_available: string[];
  active_agent: string | null;
  error?: string;
  detail?: unknown;
}

interface SourceDriver {
  id: string;
  label: string;
  alwaysOn: boolean;
  available: () => boolean;
  read: (filterAssignee?: string | null) => { tasks: KanbanTask[]; error?: string; detail?: unknown };
}

// Hermes SQLite driver — currently the canonical store.
const hermesSqliteDriver: SourceDriver = {
  id: 'hermes-sqlite',
  label: 'Hermes (SQLite · canonical)',
  alwaysOn: true,
  available() {
    try { return fs.existsSync(HERMES_DB); } catch { return false; }
  },
  read(filterAssignee) {
    const sql = `
      SELECT
        t.id, t.title, t.status, t.assignee, t.body, t.created_at, t.completed_at,
        (SELECT count(*) FROM task_comments c WHERE c.task_id = t.id) AS comment_count,
        (SELECT count(*) FROM task_attachments a WHERE a.task_id = t.id) AS attachment_count,
        (SELECT count(*) FROM task_links l WHERE l.child_id = t.id) AS parent_count
      FROM tasks t
      WHERE t.status != 'archived'
        ${filterAssignee ? `AND (t.assignee = '${filterAssignee.replace(/'/g, "''")}' OR t.assignee IS NULL OR t.assignee = '')` : ''}
      ORDER BY t.created_at DESC
      LIMIT 200;
    `;
    const r = spawnSync('sqlite3', [HERMES_DB, '-json', sql], {
      encoding: 'utf8', timeout: 5000,
    });
    if (r.status !== 0) {
      return { tasks: [], error: r.stderr || 'sqlite read failed', detail: { exit: r.status } };
    }
    let raw: any[] = [];
    try { raw = JSON.parse(r.stdout || '[]'); } catch { raw = []; }

    const tasks: KanbanTask[] = raw.map((row) => ({
      id: row.id,
      title: row.title,
      status: mapUniversalStatus(row.status),
      raw_status: row.status,
      source: hermesSqliteDriver.id,
      assignee: row.assignee || undefined,
      note: row.body || '',
      created: new Date(row.created_at * 1000).toISOString(),
      updated: row.completed_at
        ? new Date(row.completed_at * 1000).toISOString()
        : new Date(row.created_at * 1000).toISOString(),
      meta: {
        comment_count: row.comment_count,
        attachment_count: row.attachment_count,
        parent_count: row.parent_count,
      },
    }));
    tasks.reverse();
    return { tasks };
  },
};

// DuckBot JSON driver — older kanban at ~/.openclaw/workspace/state/kanban.json
const duckbotJsonDriver: SourceDriver = {
  id: 'duckbot-json',
  label: 'DuckBot (JSON state)',
  alwaysOn: false,
  available() {
    try { return fs.existsSync(DUCKBOT_JSON); } catch { return false; }
  },
  read(filterAssignee) {
    try {
      const raw = fs.readFileSync(DUCKBOT_JSON, 'utf8');
      const parsed = JSON.parse(raw);
      const raw_tasks: any[] = parsed.tasks || [];
      const tasks: KanbanTask[] = raw_tasks
        .filter((t) => {
          if (!filterAssignee) return true;
          // Match by source === agent name OR assignee field
          const a = (t.assignee || t.source || '').toLowerCase();
          return a === filterAssignee.toLowerCase() || a === '' || a === 'agent';
        })
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: mapUniversalStatus(t.status),
          raw_status: t.status,
          source: duckbotJsonDriver.id,
          assignee: t.source || t.assignee || undefined,
          note: t.note || '',
          created: t.created,
          updated: t.updated || t.created,
          meta: {},
        }));
      return { tasks };
    } catch (e: any) {
      return { tasks: [], error: e?.message || 'json read failed' };
    }
  },
};

const DRIVERS: SourceDriver[] = [hermesSqliteDriver, duckbotJsonDriver];

// ---------- Active-agent detection ----------

function detectActiveAgent(): string {
  // Best-effort: pick the driver whose most-recent task has the matching assignee
  // and was updated within the last 60s. Otherwise fall back to the env hint
  // or "hermes-sqlite".
  const hint = ACTIVE_AGENT_HINT?.toLowerCase();
  if (hint) {
    if (hint.includes('hermes')) return 'hermes-sqlite';
    if (hint.includes('openclaw') || hint.includes('duckbot')) return 'duckbot-json';
  }

  // Try to find the most recently-updated task across all available drivers;
  // whichever driver owns that task is likely the active one.
  let winner: string | null = null;
  let winnerTs = 0;
  for (const d of DRIVERS) {
    if (!d.available()) continue;
    const { tasks } = d.read();
    for (const t of tasks) {
      const ts = Date.parse(t.updated || '') || 0;
      if (ts > winnerTs) {
        winnerTs = ts;
        winner = d.id;
      }
    }
  }

  // Stale score (winner must be <60s old)
  if (winner && (Date.now() - winnerTs) < 60_000) return winner;

  // Default: Hermes (canonical store, always-on)
  return 'hermes-sqlite';
}

function readKanban(sourceId?: string): KanbanState {
  const sourcesAvailable = DRIVERS.filter((d) => d.available()).map((d) => d.id);
  const active = detectActiveAgent();
  const source = sourceId || active;
  const driver = DRIVERS.find((d) => d.id === source) || DRIVERS[0];

  if (!driver.available()) {
    // Fallback to first available
    const fallback = DRIVERS.find((d) => d.available());
    if (!fallback) {
      return {
        tasks: [],
        updated: nowIso(),
        source,
        sources_available: [],
        active_agent: ACTIVE_AGENT_HINT || null,
        error: 'no task sources available',
      };
    }
    const r = fallback.read();
    return {
      tasks: r.tasks,
      updated: nowIso(),
      source: fallback.id,
      sources_available,
      active_agent: ACTIVE_AGENT_HINT || null,
      error: `requested source '${source}' unavailable; using fallback '${fallback.id}'`,
      detail: r.error,
    };
  }

  // If this driver supports assignee filtering, pass the active agent hint
  const filterAssignee = ACTIVE_AGENT_HINT || null;
  const r = driver.read(driver === hermesSqliteDriver || driver === duckbotJsonDriver ? filterAssignee : null);

  const counts: Record<string, number> = { todo: 0, doing: 0, done: 0, failed: 0 };
  for (const t of r.tasks) counts[t.status] = (counts[t.status] || 0) + 1;

  return {
    tasks: r.tasks,
    updated: nowIso(),
    counts,
    source: driver.id,
    sources_available: sourcesAvailable,
    active_agent: ACTIVE_AGENT_HINT || null,
    error: r.error,
    detail: r.detail,
  };
}

function writeHermesTask(task: any) {
  // Canonical store is still Hermes SQLite. All writes flow through `hermes kanban create`.
  // Source registry is read-side architecture; writes stay central to avoid data loss.
  const r = spawnSync(HERMES_CLI, [
    'kanban', 'create',
    String(task.title || '').slice(0, 240),
    '--assignee', String(task.assignee || task.source || ACTIVE_AGENT_HINT || 'duckbot').slice(0, 60),
    '--body', String(task.note || '').slice(0, 1000),
  ], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) return { success: false, error: r.stderr || r.stdout || 'hermes create failed' };
  const m = (r.stdout || '').match(/t_[a-z0-9]+|t-\d+-[a-z0-9]+/);
  return { success: true, task_id: m ? m[0] : null, raw: r.stdout };
}

function kanbanPlugin() {
  return {
    name: 'brain-3d-kanban-plugin',
    configureServer(server: any) {
      // /api/kanban/sources must register FIRST — Connect middleware matches
      // by prefix and /api/kanban would otherwise swallow it.
      server.middlewares.use('/api/kanban/sources', (req: any, res: any) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        const sources = DRIVERS.map((d) => ({
          id: d.id,
          label: d.label,
          available: d.available(),
          alwaysOn: d.alwaysOn,
        }));
        const active = detectActiveAgent();
        res.end(JSON.stringify({ sources, active_agent: active, hint: ACTIVE_AGENT_HINT, ts: nowIso() }));
      });

      server.middlewares.use('/api/kanban', (req: any, res: any) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'GET') {
          // Allow ?source=X override for testing/switching
          const url = String(req.url || '');
          const m = url.match(/[?&]source=([^&]+)/);
          const requested = m ? decodeURIComponent(m[1]) : undefined;
          const state = readKanban(requested);
          return res.end(JSON.stringify(state));
        }

        if (req.method === 'POST') {
          const url = String(req.url || '');
          if (url.endsWith('/append') || url.endsWith('/append/')) {
            let body = '';
            req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
            req.on('end', () => {
              let parsed: any = {};
              try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
              const task = parsed.task;
              if (!task || typeof task !== 'object' || !task.title) {
                res.statusCode = 400;
                return res.end(JSON.stringify({ error: 'task.title required' }));
              }
              const result = writeHermesTask(task);
              if (!result.success) {
                res.statusCode = 502;
                return res.end(JSON.stringify({ error: 'hermes write failed', detail: result.error }));
              }
              return res.end(JSON.stringify({ success: true, action: 'created', task_id: result.task_id }));
            });
            return;
          }
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: 'unknown action', url: req.url }));
        }

        res.statusCode = 405;
        res.end(JSON.stringify({ error: 'method not allowed' }));
      });

    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), kanbanPlugin()],
  server: { host: '127.0.0.1' },
});
