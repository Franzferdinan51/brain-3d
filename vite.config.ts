import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// Hermes Kanban integration (2026-07-02 21:13 EDT)
//
// Source of truth: ~/.hermes/kanban.db (SQLite, Hermes Agent v0.18.0+)
// Bridge layer:    this Vite plugin reads SQLite via the `sqlite3` CLI,
//                  writes via `hermes kanban create` / `hermes kanban complete`.
//
// Why Hermes Kanban (instead of our JSON state file):
//   - Multi-agent coordination: named profiles (assignees), parent/child links
//   - 7-state machine: triage/todo/ready/running/blocked/done/archived
//   - Comment threads (task_comments table) for inter-agent handoffs
//   - File attachments (task_attachments table) up to 25 MB per task
//   - Idempotency keys for retried automation
//   - Dispatcher loop reclaims crashed workers via PID + TTL
//   - Multi-board isolation by directory
//
// Our 4-column view mapping:
//   todo (our)    ← todo     | ready    (Hermes)
//   doing (ours)  ← running  (Hermes)
//   done (ours)   ← done     (Hermes)
//   failed (ours) ← blocked  (Hermes)
//
// brain-3d is now a *viewer* for the Hermes Kanban. All writes go through
// the Hermes CLI which gives us audit trail + dispatcher + handoffs for free.
// ============================================================================

const HERMES_DB = path.join(os.homedir(), '.hermes', 'kanban.db');
const HERMES_CLI = path.join(os.homedir(), '.local', 'bin', 'hermes');

// Map Hermes 7-state → our 4-column display.
// We collapse into 4 columns because the brain-3d HUD is visual.
// Hermes sees everything fine — this is just our display simplification.
function hermesStatusToColumn(s: string): string {
  switch (s) {
    case 'triage':
    case 'todo':
    case 'ready':
    case 'scheduled':
      return 'todo';          // not started yet
    case 'running':
      return 'doing';          // actively worked on
    case 'blocked':
      return 'failed';         // waiting on something (treated as failed for display)
    case 'done':
      return 'done';           // completed
    case 'archived':
      return 'done';           // archived counts as done for display
    default:
      return 'todo';
  }
}

function readHermesKanban() {
  // Spawn sqlite3 to read all tasks + comment counts.
  // Output: array of {id, title, status, assignee, body, created_at, completed_at, comments}
  const sql = `
    SELECT
      t.id, t.title, t.status, t.assignee, t.body, t.created_at, t.completed_at,
      (SELECT count(*) FROM task_comments c WHERE c.task_id = t.id) AS comment_count,
      (SELECT count(*) FROM task_attachments a WHERE a.task_id = t.id) AS attachment_count,
      (SELECT count(*) FROM task_links l WHERE l.child_id = t.id) AS parent_count
    FROM tasks t
    WHERE t.status != 'archived'
    ORDER BY t.created_at DESC
    LIMIT 200;
  `;
  const r = spawnSync('sqlite3', [HERMES_DB, '-json', sql], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (r.status !== 0) {
    return { tasks: [], updated: new Date().toISOString(), error: r.stderr || 'sqlite read failed' };
  }
  let raw: any[] = [];
  try {
    raw = JSON.parse(r.stdout || '[]');
  } catch {
    raw = [];
  }
  // Shape to brain-3d's expected format
  const tasks = raw.map((row) => ({
    id: row.id,
    title: row.title,
    status: hermesStatusToColumn(row.status),
    hermes_status: row.status,           // expose full status so we can show it on hover
    source: row.assignee || 'unknown',
    note: row.body || '',
    created: new Date(row.created_at * 1000).toISOString(),
    updated: row.completed_at
      ? new Date(row.completed_at * 1000).toISOString()
      : new Date(row.created_at * 1000).toISOString(),
    comment_count: row.comment_count,
    attachment_count: row.attachment_count,
    parent_count: row.parent_count,
  }));
  // Reverse so newest is at the bottom (column-wise display)
  tasks.reverse();
  // Counts
  const counts: Record<string, number> = { todo: 0, doing: 0, done: 0, failed: 0 };
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] || 0) + 1;
  }
  return { tasks, updated: new Date().toISOString(), counts, source: 'hermes', path: HERMES_DB };
}

function writeHermesTask(task: any) {
  // POST endpoint: route through `hermes kanban create` so the SQLite row is
  // canonical, has a UUID, and the dispatcher can pick it up.
  const r = spawnSync(HERMES_CLI, [
    'kanban', 'create',
    String(task.title || '').slice(0, 240),
    '--assignee', String(task.source || 'duckbot').slice(0, 60),
    '--body', String(task.note || '').slice(0, 1000),
  ], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) return { success: false, error: r.stderr || r.stdout || 'hermes create failed' };
  // Parse the created task id out of the stdout (hermes prints "→ t_xxxxx")
  const m = (r.stdout || '').match(/t_[a-z0-9]+|t-\d+-[a-z0-9]+/);
  return { success: true, task_id: m ? m[0] : null, raw: r.stdout };
}

function kanbanPlugin() {
  return {
    name: 'brain-3d-kanban-hermes',
    configureServer(server: any) {
      server.middlewares.use('/api/kanban', (req: any, res: any) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'GET') {
          const state = readHermesKanban();
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