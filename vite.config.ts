import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Live kanban middleware (2026-07-02): exposes the agent's task stream as a
// JSON-backed state file. Used by the new Kanban tab inside brain-3d.
const KANBAN_STATE_DIR = path.join(os.homedir(), '.openclaw', 'workspace', 'state');
const KANBAN_STATE_FILE = path.join(KANBAN_STATE_DIR, 'kanban.json');
const KANBAN_MAX_TASKS = 50;

function ensureStateFile() {
  fs.mkdirSync(KANBAN_STATE_DIR, { recursive: true });
  if (!fs.existsSync(KANBAN_STATE_FILE)) {
    fs.writeFileSync(KANBAN_STATE_FILE, JSON.stringify({ tasks: [], updated: new Date().toISOString() }, null, 2));
  }
}

function readKanban() {
  ensureStateFile();
  try {
    const raw = JSON.parse(fs.readFileSync(KANBAN_STATE_FILE, 'utf8'));
    return {
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
      updated: raw.updated || new Date().toISOString(),
    };
  } catch {
    return { tasks: [], updated: new Date().toISOString() };
  }
}

function writeKanban(state: { tasks: any[]; updated: string }) {
  ensureStateFile();
  const tmp = KANBAN_STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, KANBAN_STATE_FILE);
}

function kanbanPlugin() {
  return {
    name: 'brain-3d-kanban',
    configureServer(server: any) {
      server.middlewares.use('/api/kanban', (req: any, res: any) => {
        // CORS for the embedded Kanban in the same-origin dashboard
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'GET') {
          const state = readKanban();
          return res.end(
            JSON.stringify({
              ...state,
              source: 'fs',
              path: KANBAN_STATE_FILE,
              counts: state.tasks.reduce((acc: any, t: any) => {
                const s = t.status || 'todo';
                acc[s] = (acc[s] || 0) + 1;
                return acc;
              }, {}),
            }),
          );
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
              const validStatus = ['todo', 'doing', 'done', 'failed'];
              if (task.status && !validStatus.includes(task.status)) {
                res.statusCode = 400;
                return res.end(JSON.stringify({ error: 'invalid status', valid: validStatus }));
              }
              const state = readKanban();
              const now = new Date().toISOString();
              if (task.id) {
                const existing = state.tasks.find((t: any) => t.id === task.id);
                if (existing) {
                  if (task.title) existing.title = String(task.title).slice(0, 240);
                  if (task.status) existing.status = task.status;
                  if (task.note !== undefined) existing.note = String(task.note).slice(0, 480);
                  if (task.source) existing.source = String(task.source).slice(0, 60);
                  existing.updated = now;
                  if (state.tasks.length > KANBAN_MAX_TASKS) state.tasks = state.tasks.slice(-KANBAN_MAX_TASKS);
                  state.updated = now;
                  try { writeKanban(state); }
                  catch (e: any) {
                    res.statusCode = 500;
                    return res.end(JSON.stringify({ error: 'write failed', detail: e.message }));
                  }
                  return res.end(JSON.stringify({ success: true, action: 'updated', task: existing, count: state.tasks.length }));
                }
              }
              const newTask = {
                id: task.id || `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                title: String(task.title).slice(0, 240),
                source: String(task.source || 'agent').slice(0, 60),
                status: task.status || 'todo',
                created: task.created || now,
                updated: now,
              };
              if (task.note) newTask.note = String(task.note).slice(0, 480);
              state.tasks.push(newTask);
              if (state.tasks.length > KANBAN_MAX_TASKS) state.tasks = state.tasks.slice(-KANBAN_MAX_TASKS);
              state.updated = now;
              try {
                writeKanban(state);
                res.end(JSON.stringify({ success: true, action: 'created', task: newTask, count: state.tasks.length }));
              } catch (e: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: 'write failed', detail: e.message }));
              }
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
