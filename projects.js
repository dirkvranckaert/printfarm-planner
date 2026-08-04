'use strict';

// Project resolution + summary helpers. A project groups jobs by a free-text
// name; the match key is lowercase(trim(name)), the display label is the name
// in the casing it was FIRST entered. All functions take the db explicitly so
// tests can pass a throwaway in-memory database.

// Status buckets (exact groupings — see the Projects feature spec).
const TO_PRINT_STATUSES = new Set(['Planned', 'Awaiting', 'Awaiting Printer', 'Paused']);
const BUSY_STATUSES     = new Set(['Printing', 'Post Printing']);

// Which bucket a job status falls into: 'done' | 'busy' | 'toprint'.
function bucketOf(status) {
  if (status === 'Done') return 'done';
  if (BUSY_STATUSES.has(status)) return 'busy';
  return 'toprint';
}

// Normalise a free-text project name to its match id. Empty/whitespace -> ''.
function normalizeId(name) {
  return String(name == null ? '' : name).trim().toLowerCase();
}

// Resolve a free-text project name to a project row, creating or reopening as
// needed. Returns null for a blank name (no project). Otherwise returns
// { id, label, created, reopened }:
//   - created:  a brand-new row was inserted (first-ever use of this name).
//   - reopened: an existing CLOSED project was flipped back to open because
//               this action gives it an active task.
// The caller fires the first-create push only when `created` is true.
function resolveProject({ db, name }) {
  const id = normalizeId(name);
  if (!id) return null;
  const row = db.prepare('SELECT id, label, status FROM projects WHERE id=?').get(id);
  if (!row) {
    const label = String(name).trim();
    db.prepare('INSERT INTO projects (id, label, status) VALUES (?,?,?)').run(id, label, 'open');
    return { id, label, created: true, reopened: false };
  }
  let reopened = false;
  if (row.status === 'closed') {
    db.prepare("UPDATE projects SET status='open' WHERE id=?").run(id);
    reopened = true;
  }
  return { id, label: row.label, created: false, reopened };
}

// Assign a job to an EXISTING project only (context-menu path). Never creates.
// Returns { ok:false, code } when the project id is unknown, else
// { ok:true, id, label, reopened } (reopening a closed project is allowed —
// the assignment gives it an active task).
function assignExisting({ db, jobId, projectId }) {
  const id = normalizeId(projectId);
  if (!id) return { ok: false, code: 400 };
  const row = db.prepare('SELECT id, label, status FROM projects WHERE id=?').get(id);
  if (!row) return { ok: false, code: 404 };
  let reopened = false;
  if (row.status === 'closed') {
    db.prepare("UPDATE projects SET status='open' WHERE id=?").run(id);
    reopened = true;
  }
  db.prepare('UPDATE jobs SET project_id=? WHERE id=?').run(id, jobId);
  return { ok: true, id, label: row.label, reopened };
}

// Compute per-project counts { toPrint, busy, done, total } keyed by project id.
function countsByProject(db) {
  const rows = db.prepare("SELECT project_id AS pid, status FROM jobs WHERE project_id IS NOT NULL AND (queued IS NULL OR queued=0)").all();
  const map = {};
  for (const r of rows) {
    const m = map[r.pid] || (map[r.pid] = { toPrint: 0, busy: 0, done: 0, total: 0 });
    const b = bucketOf(r.status);
    if (b === 'done') m.done++;
    else if (b === 'busy') m.busy++;
    else m.toPrint++;
    m.total++;
  }
  return map;
}

// Which sort group a summary belongs to (lower = higher in the list):
//   0 = open + active (has to-print or busy jobs)
//   1 = open + completed (zero to-print/busy jobs)
//   2 = closed (always very bottom)
function sortGroup(p) {
  if (p.status === 'closed') return 2;
  return (p.toPrint + p.busy) > 0 ? 0 : 1;
}

// Build the sorted project summary list for GET /api/projects. Active projects
// first (most active first), completed below, closed at the very bottom.
function summaries(db) {
  const projects = db.prepare('SELECT id, label, status, created_at FROM projects').all();
  const counts = countsByProject(db);
  const list = projects.map(p => {
    const c = counts[p.id] || { toPrint: 0, busy: 0, done: 0, total: 0 };
    return { id: p.id, label: p.label, status: p.status, created_at: p.created_at,
             toPrint: c.toPrint, busy: c.busy, done: c.done, total: c.total,
             active: (c.toPrint + c.busy) > 0 };
  });
  list.sort((a, b) => {
    const ga = sortGroup(a), gb = sortGroup(b);
    if (ga !== gb) return ga - gb;
    if (ga === 0) {
      const d = (b.toPrint + b.busy) - (a.toPrint + a.busy); // most active first
      if (d !== 0) return d;
    }
    return a.label.localeCompare(b.label);
  });
  return list;
}

module.exports = {
  TO_PRINT_STATUSES, BUSY_STATUSES, bucketOf, normalizeId,
  resolveProject, assignExisting, countsByProject, sortGroup, summaries,
};
