// =============================================================================
// PrintFarm Planner — app.js
// =============================================================================

// ---- Constants ----
const HOUR_HEIGHT = 60;          // px per hour — MUST match --hour-height in style.css
const DAY_START   = 0;           // first hour rendered in day view
const DAY_END     = 24;          // exclusive
const DAY_MINS    = (DAY_END - DAY_START) * 60;  // 1440

const PRESET_COLORS = [
  '#4f9cf9', '#f94f4f', '#22c55e', '#f59e0b', '#a855f7',
  '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1',
];

// Mutable — overwritten by loadStatusColors() on init and after settings save
let statusMeta = {
  'Planned':       { color: '#0f766e' },
  'Printing':      { color: '#16a34a' },
  'Post Printing': { color: '#d97706' },
  'Done':          { color: '#64748b' },
};

// ---- API helper ----
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await res.text());
  return method === 'DELETE' ? null : res.json();
}

// ---- Live status helpers ----
// Status is keyed as "{brand}:{printerKey}" — e.g. "bambulab:01P00A123456789".
// Add a case here when a new brand integration is added.
function printerStatusKey(printer) {
  if (printer.brand === 'bambulab' && printer.bambu_serial) return `bambulab:${printer.bambu_serial}`;
  // Future brands:
  // if (printer.brand === 'prusa' && printer.prusa_serial) return `prusa:${printer.prusa_serial}`;
  return null;
}

function getPrinterLiveStatus(printer) {
  const key = printerStatusKey(printer);
  if (!key) return null;
  return printerStatus[key] ?? null;
}

function printerStatusLabel(s) {
  if (!s) return null;
  if (s.stage === 'RUNNING') return s.progress > 0 ? `${s.progress}%` : 'Printing';
  if (s.stage === 'PAUSE')   return 'Paused';
  if (s.stage === 'FAILED')  return 'Error';
  if (s.stage === 'FINISH')  return 'Done';
  if (s.stage === 'IDLE')    return 'Idle';
  return null;
}

function printerStatusPillHtml(printer) {
  const s = getPrinterLiveStatus(printer);
  const label = printerStatusLabel(s);
  if (!label) return '';
  const cls = s.stage.toLowerCase();
  return `<span class="printer-status-pill printer-status-${cls}">${escHtml(label)}</span>`;
}

function slotCardHtml(slot) {
  const bg      = slot.color || 'var(--surface-2)';
  const fg      = slot.color ? contrastColor(slot.color) : 'var(--text-muted)';
  const active  = slot.active ? ' ams-slot-active' : '';
  const kText   = slot.k != null ? `K ${slot.k.toFixed(3)}` : '';
  const matText = slot.empty ? 'Empty' : (slot.material || '?');
  return `<div class="ams-slot-wrap${slot.active ? ' ams-slot-wrap-active' : ''}">
    <div class="ams-slot${active}" style="background:${bg};color:${fg}">
      <div class="ams-slot-mat">${escHtml(matText)}</div>
      ${kText ? `<div class="ams-slot-k">${escHtml(kText)}</div>` : ''}
      <div class="ams-slot-id">${escHtml(slot.id)}</div>
    </div>
    ${slot.active ? '<div class="ams-slot-arrow"></div>' : ''}
  </div>`;
}

// Return a light or dark hex based on perceived luminance of a hex bg color.
function contrastColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? '#111' : '#fff';
}

// Build the detail block (stage, progress bar, temps, remaining, AMS slots) for a printer.
// Used by both the topbar hover popup and the mobile status panel.
function printerDetailHtml(s) {
  if (!s) return `<div class="spopup-stage spopup-dim">Waiting for data…</div>`;

  const stageText = s.stage === 'RUNNING' ? `Printing${s.progress > 0 ? ` · ${s.progress}%` : ''}` :
                    s.stage === 'PAUSE'   ? 'Paused' :
                    s.stage === 'FINISH'  ? 'Finished' :
                    s.stage === 'FAILED'  ? 'Error' : 'Idle';
  let html = `<div class="spopup-stage">${stageText}</div>`;
  if (s.stage === 'RUNNING' && s.progress > 0) {
    html += `<div class="spopup-bar-wrap"><div class="spopup-bar-fill" style="width:${s.progress}%"></div></div>`;
  }
  const details = [];
  if (s.nozzle_temp != null) {
    const cur = Math.round(s.nozzle_temp);
    const tgt = s.nozzle_target != null && s.nozzle_target > 0 ? Math.round(s.nozzle_target) : null;
    details.push(`🌡 ${cur}°${tgt ? ` / ${tgt}°` : ''}`);
  }
  if (s.bed_temp != null) {
    const cur = Math.round(s.bed_temp);
    const tgt = s.bed_target != null && s.bed_target > 0 ? Math.round(s.bed_target) : null;
    details.push(`🛏 ${cur}°${tgt ? ` / ${tgt}°` : ''}`);
  }
  if (s.remaining != null && s.remaining > 0) {
    const h = Math.floor(s.remaining / 60), m = s.remaining % 60;
    details.push(`⏱ ${h > 0 ? h + 'h ' : ''}${m}m left`);
  }
  if (details.length) html += `<div class="spopup-details">${details.map(d => `<span>${escHtml(d)}</span>`).join('')}</div>`;

  if (s.slots && s.slots.length) {
    const amsSlots = s.slots.filter(sl => sl.id !== 'Ext');
    const extSlot  = s.slots.find(sl => sl.id === 'Ext');
    if (amsSlots.length) {
      const rows = [];
      for (let i = 0; i < amsSlots.length; i += 4) rows.push(amsSlots.slice(i, i + 4));
      html += `<div class="spopup-ams">${rows.map(row => `<div class="spopup-ams-row">${row.map(sl => slotCardHtml(sl)).join('')}</div>`).join('')}</div>`;
    }
    if (extSlot) {
      html += `<div class="spopup-ams spopup-ams-ext"><div class="spopup-ams-label">External</div><div class="spopup-ams-row">${slotCardHtml(extSlot)}</div></div>`;
    }
  }
  return html;
}

function renderTopbarStatus() {
  const bar = document.getElementById('printer-status-bar');
  if (!bar) return;

  const connectedPrinters = printers.filter(p => printerStatusKey(p));
  if (!connectedPrinters.length) { bar.innerHTML = ''; renderStatusPanel(connectedPrinters); return; }

  const visible  = connectedPrinters.slice(0, topbarLimit);
  const overflow = connectedPrinters.slice(topbarLimit);

  const chipHtml = visible.map(p => {
    const s     = getPrinterLiveStatus(p);
    const label = printerStatusLabel(s);
    const cls   = s ? s.stage.toLowerCase() : '';
    return `<div class="schip-wrap">
      <div class="schip">
        <span class="schip-dot" style="background:${p.color}"></span>
        <span class="schip-name">${escHtml(p.name)}</span>
        ${label ? `<span class="printer-status-pill printer-status-${cls}">${escHtml(label)}</span>` : ''}
      </div>
      <div class="schip-popup">
        <div class="spopup-name">${escHtml(p.name)}</div>
        ${printerDetailHtml(s)}
      </div>
    </div>`;
  }).join('');

  let overflowHtml = '';
  if (overflow.length) {
    const anyActive = overflow.some(p => getPrinterLiveStatus(p)?.stage === 'RUNNING');
    overflowHtml = `<div class="schip-wrap schip-overflow-wrap" id="schip-overflow-wrap">
      <button class="schip schip-overflow" id="btn-overflow-chips" aria-expanded="false">
        ${anyActive ? `<span class="overflow-dot"></span>` : ''}
        +${overflow.length} more
      </button>
      <div class="schip-popup schip-overflow-panel" id="schip-overflow-panel">
        ${overflow.map(p => {
          const s   = getPrinterLiveStatus(p);
          const label = printerStatusLabel(s);
          const cls   = s ? s.stage.toLowerCase() : '';
          return `<div class="overflow-card">
            <div class="overflow-card-header">
              <span class="schip-dot" style="background:${p.color}"></span>
              <span class="overflow-card-name">${escHtml(p.name)}</span>
              ${label ? `<span class="printer-status-pill printer-status-${cls}">${escHtml(label)}</span>` : ''}
            </div>
            <div class="overflow-card-body">${printerDetailHtml(s)}</div>
          </div>`;
        }).join('<hr class="overflow-divider">')}
      </div>
    </div>`;
  }

  // Preserve open state before replacing DOM
  const overflowWasOpen = document.getElementById('schip-overflow-panel')
    ?.classList.contains('schip-overflow-open') ?? false;

  bar.innerHTML = chipHtml + overflowHtml;

  // Restore open state after re-render
  if (overflowWasOpen) {
    document.getElementById('schip-overflow-panel')?.classList.add('schip-overflow-open');
    document.getElementById('btn-overflow-chips')?.setAttribute('aria-expanded', 'true');
  }

  // Wire up overflow toggle (re-attached after innerHTML replace)
  const overflowBtn = document.getElementById('btn-overflow-chips');
  if (overflowBtn) overflowBtn.addEventListener('click', e => { e.stopPropagation(); toggleOverflowPanel(); });

  renderStatusPanel(connectedPrinters);
}

function toggleOverflowPanel() {
  const panel = document.getElementById('schip-overflow-panel');
  const btn   = document.getElementById('btn-overflow-chips');
  if (!panel) return;
  const opening = panel.classList.toggle('schip-overflow-open');
  btn.setAttribute('aria-expanded', String(opening));
}

// Close overflow panel when clicking anywhere outside it
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('schip-overflow-wrap');
  if (wrap && !wrap.contains(e.target)) {
    const panel = document.getElementById('schip-overflow-panel');
    const btn   = document.getElementById('btn-overflow-chips');
    if (panel) { panel.classList.remove('schip-overflow-open'); btn?.setAttribute('aria-expanded', 'false'); }
  }
});

// Mobile status panel — one card per connected printer.
function renderStatusPanel(connectedPrinters) {
  const panel  = document.getElementById('printer-status-panel');
  const btn    = document.getElementById('btn-printer-status');
  const badge  = document.getElementById('printer-status-badge');
  if (!panel || !btn) return;

  const list = connectedPrinters ?? printers.filter(p => printerStatusKey(p));

  // Show/hide the toggle button
  btn.classList.toggle('hidden', list.length === 0);

  // Badge dot: green if any printer is RUNNING, grey otherwise
  const anyRunning = list.some(p => getPrinterLiveStatus(p)?.stage === 'RUNNING');
  badge.innerHTML  = list.length ? `<span class="status-badge" style="background:${anyRunning ? '#22c55e' : '#94a3b8'}"></span>` : '';

  // Build cards
  panel.innerHTML = list.map(p => {
    const s   = getPrinterLiveStatus(p);
    const label = printerStatusLabel(s);
    const cls   = s ? s.stage.toLowerCase() : '';
    return `<div class="ps-card">
      <div class="ps-card-header">
        <span class="ps-card-dot" style="background:${p.color}"></span>
        <span class="ps-card-name">${escHtml(p.name)}</span>
        ${label ? `<span class="printer-status-pill printer-status-${cls}">${escHtml(label)}</span>` : ''}
      </div>
      <div class="ps-card-body">${printerDetailHtml(s)}</div>
    </div>`;
  }).join('');
}

function toggleStatusPanel() {
  const panel = document.getElementById('printer-status-panel');
  const btn   = document.getElementById('btn-printer-status');
  if (!panel) return;
  const open = panel.classList.toggle('hidden');
  btn.setAttribute('aria-expanded', String(!open));
}

// ---- App state ----
let view           = 'day';
let navDate        = todayMidnight();
let printers       = [];
let editJobId      = null;
let editPrintId    = null;
let savedScrollTop = 0;    // scroll position saved before opening job modal
let ctxJobId       = null; // job ID targeted by the current context menu
let drag           = null; // active drag state
let showTodayPanel    = false;
let showQueuePanel    = false;
let editingJobStatus  = 'Planned';
let jobsCache       = {};   // id → job, updated on each full DB fetch
let lastDragMoved  = false;
let closures       = [];   // loaded before every render
let editClosureId  = null;
let printerStatus  = {};   // keyed by "brand:serial" — live status from SSE
let topbarLimit    = 3;    // max chips shown before overflow; set from /api/config

// =============================================================================
// Init
// =============================================================================
function applyTheme(mode) {
  if (mode === 'dark')       document.documentElement.setAttribute('data-theme', 'dark');
  else if (mode === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else                       document.documentElement.removeAttribute('data-theme');
}

async function init() {
  // Load server-side config (env-driven)
  const config = await api('GET', '/api/config').catch(() => null);
  if (config?.topbarPrinterLimit > 0) topbarLimit = config.topbarPrinterLimit;

  // Apply saved theme before first render
  const themeSetting = await api('GET', '/api/settings/theme');
  applyTheme(themeSetting?.value ?? 'system');

  // Apply saved default view before first render
  const dvSetting = await api('GET', '/api/settings/defaultView');
  if (dvSetting) view = dvSetting.value;

  // Apply queue auto-expand setting
  const qaeSetting = await api('GET', '/api/settings/queueAutoExpand');
  if (qaeSetting?.value === true) {
    const allJobs = await api('GET', '/api/jobs');
    if (allJobs.some(j => j.queued)) showQueuePanel = true;
  }

  await loadStatusColors();
  printers = await api('GET', '/api/printers');

  // Connect to live Bambu printer status stream
  const sse = new EventSource('/api/printers/status/stream');
  sse.onmessage = (e) => {
    try {
      const updates = JSON.parse(e.data);
      Object.assign(printerStatus, updates);
      renderTopbarStatus();
    } catch (_) {}
  };
  sse.onerror = () => {}; // silently ignore — server may not have Bambu configured

  renderCalendar();
  renderTopbarStatus();
  setupListeners();
  if (printers.length === 0) openPrintersModal();
  else if (view === 'day') setTimeout(scrollToNow, 80);
}

// =============================================================================
// Date helpers
// =============================================================================
function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}

// Monday-based week start
function weekStart(date) {
  const d = new Date(date);
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

function toDatetimeLocal(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

function fmtDate(date, fmt) {
  const DAY_LONG  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const DAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MON_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MON_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return fmt
    .replace('DDDD', DAY_LONG[date.getDay()])
    .replace('DDD',  DAY_SHORT[date.getDay()])
    .replace('MMMM', MON_LONG[date.getMonth()])
    .replace('MMM',  MON_SHORT[date.getMonth()])
    .replace('DD',   String(date.getDate()).padStart(2,'0'))
    .replace('D',    String(date.getDate()))
    .replace('YYYY', date.getFullYear())
    .replace('MM',   String(date.getMonth()+1).padStart(2,'0'));
}

// Does the job overlap [rangeStart, rangeEnd) ?
function overlapsRange(job, rangeStart, rangeEnd) {
  return new Date(job.start) < rangeEnd && new Date(job.end) > rangeStart;
}

function overlapsDay(job, day) {
  const s = new Date(day); s.setHours(0, 0, 0, 0);
  const e = new Date(day); e.setHours(23, 59, 59, 999);
  return overlapsRange(job, s, e);
}

// Returns the closure record if `date` falls within any closure, else undefined.
function closureForDay(date) {
  const key = toDateKey(date);
  return closures.find(c => c.startDate <= key && key <= c.endDate);
}

function isDayClosed(date) {
  return !!closureForDay(date);
}

// =============================================================================
// Colour helpers
// =============================================================================
async function loadStatusColors() {
  const saved = await api('GET', '/api/settings/statusColors');
  const colors = saved?.value ?? {};
  statusMeta = {
    'Planned':       { color: colors['Planned']       ?? '#0f766e' },
    'Printing':      { color: colors['Printing']      ?? '#16a34a' },
    'Post Printing': { color: colors['Post Printing'] ?? '#d97706' },
    'Done':          { color: colors['Done']          ?? '#64748b' },
  };
}

function statusBadgeStyle(status) {
  const color = statusMeta[status]?.color ?? '#888';
  return `background:${hexRgba(color, 0.15)};color:${color}`;
}

function hexRgba(hex, a) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

// Darken a hex colour by mixing toward black at `amount` (0=original, 1=black)
function darken(hex, amount = 0.35) {
  const r = Math.round(parseInt(hex.slice(1,3),16) * (1 - amount));
  const g = Math.round(parseInt(hex.slice(3,5),16) * (1 - amount));
  const b = Math.round(parseInt(hex.slice(5,7),16) * (1 - amount));
  return `rgb(${r},${g},${b})`;
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// =============================================================================
// Conflict detection
// =============================================================================
function detectConflicts(jobs) {
  const ids = new Set();
  for (let i = 0; i < jobs.length; i++) {
    for (let j = i + 1; j < jobs.length; j++) {
      if (jobs[i].printerId !== jobs[j].printerId) continue;
      if (new Date(jobs[i].start) < new Date(jobs[j].end) &&
          new Date(jobs[i].end)   > new Date(jobs[j].start)) {
        ids.add(jobs[i].id);
        ids.add(jobs[j].id);
      }
    }
  }
  return ids;
}

function minutesOnDay(job, day) {
  const ds = new Date(day); ds.setHours(0, 0, 0, 0);
  const de = new Date(day); de.setHours(23, 59, 59, 999);
  const s  = Math.max(new Date(job.start).getTime(), ds.getTime());
  const e  = Math.min(new Date(job.end).getTime(),   de.getTime());
  return Math.max(0, (e - s) / 60_000);
}

// =============================================================================
// Calendar dispatcher
// =============================================================================
async function renderCalendar() {
  closures = await api('GET', '/api/closures');
  updateHeader();
  await renderTodayPanel();
  await renderQueuePanel();
  if      (view === 'day')      await renderDay();
  else if (view === 'week')     await renderWeek();
  else if (view === 'upcoming') await renderUpcoming();
  else                          await renderMonth();
}

function updateHeader() {
  const label = document.getElementById('date-label');
  if (view === 'day') {
    label.textContent = fmtDate(navDate, 'DDDD, D MMMM YYYY');
  } else if (view === 'week') {
    const ws = weekStart(navDate);
    const we = addDays(ws, 6);
    label.textContent = ws.getMonth() === we.getMonth()
      ? `${fmtDate(ws,'D')} – ${fmtDate(we,'D MMMM YYYY')}`
      : `${fmtDate(ws,'D MMM')} – ${fmtDate(we,'D MMM YYYY')}`;
  } else if (view === 'upcoming') {
    label.textContent = 'Upcoming Jobs';
  } else {
    label.textContent = fmtDate(navDate, 'MMMM YYYY');
  }
  ['day','week','month','upcoming'].forEach(v => {
    const btn = document.getElementById(`btn-${v}`);
    if (btn) btn.classList.toggle('active', view === v);
  });
}

// =============================================================================
// Today panel
// =============================================================================
async function renderTodayPanel() {
  const panel = document.getElementById('today-panel');
  if (!showTodayPanel || !printers.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const today    = todayMidnight();
  const allJobs  = await api('GET', '/api/jobs');
  const todayJobs = allJobs.filter(j => !j.queued && overlapsDay(j, today))
                           .sort((a, b) => new Date(a.start) - new Date(b.start));

  const p2 = n => String(n).padStart(2, '0');
  const fmtTime = d => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

  let h = '<div class="today-panel-header">Today\'s Overview</div>';

  // Utilization per printer
  h += '<div>';
  printers.forEach(p => {
    const pJobs = todayJobs.filter(j => j.printerId === p.id);
    const busyMins = pJobs.reduce((sum, j) => sum + minutesOnDay(j, today), 0);
    const pct = Math.min(100, Math.round(busyMins / 1440 * 100));
    const busyH = Math.floor(busyMins / 60), busyM = Math.round(busyMins % 60);
    const busyStr = busyH > 0 ? (busyM > 0 ? `${busyH}h ${busyM}m` : `${busyH}h`) : `${busyM}m`;
    h += `<div class="today-util-row">
      <div class="today-util-dot" style="background:${p.color}"></div>
      <div class="today-util-name" title="${escHtml(p.name)}">${escHtml(p.name)}</div>
      <div class="today-util-bar-wrap">
        <div class="today-util-bar" style="width:${pct}%;background:${p.color}"></div>
      </div>
      <div class="today-util-pct">${pct}%</div>
      <div style="color:var(--text-muted);font-size:11px;width:50px;text-align:right">${busyStr}</div>
    </div>`;
  });
  h += '</div>';

  if (todayJobs.length) {
    h += '<hr class="today-panel-divider"><div class="today-jobs-list">';
    todayJobs.forEach(job => {
      const p   = printers.find(pr => pr.id === job.printerId);
      const col = p?.color ?? '#888';
      const status = job.status ?? 'Planned';
      const label = job.orderNr ? `#${escHtml(job.orderNr)} — ${escHtml(job.name)}` : escHtml(job.name);
      const timeStr = `${fmtTime(new Date(job.start))} – ${fmtTime(new Date(job.end))}`;
      h += `<div class="today-job-row" data-job-id="${job.id}">
        <div class="today-job-time">${timeStr}</div>
        <div class="today-util-dot" style="background:${col}"></div>
        <div class="today-job-name" title="${escHtml(job.name)}">${label}</div>
        <span class="job-status-badge" style="${statusBadgeStyle(status)}">${escHtml(status)}</span>
      </div>`;
    });
    h += '</div>';
  } else {
    h += '<div style="color:var(--text-muted);font-size:12px;margin-top:8px">No jobs scheduled today.</div>';
  }

  panel.innerHTML = h;

  // Click job row → open modal
  panel.querySelectorAll('.today-job-row[data-job-id]').forEach(row => {
    row.addEventListener('click', () => openJobModal(parseInt(row.dataset.jobId)));
  });
}

// =============================================================================
// Queue panel
// =============================================================================
async function renderQueuePanel() {
  const panel = document.getElementById('queue-panel');
  const btn   = document.getElementById('btn-queue');

  // Always fetch to update button badge, even if panel is hidden
  const allJobs    = await api('GET', '/api/jobs');
  const queued     = allJobs.filter(j => j.queued);
  const count      = queued.length;

  btn.textContent = count ? `Queue (${count})` : 'Queue';
  btn.classList.toggle('active', showQueuePanel);

  if (!showQueuePanel) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  if (!count) {
    panel.innerHTML = '<div class="queue-panel-inner"><span class="queue-panel-title">Print Queue</span><button class="btn btn-primary btn-sm" id="queue-add-btn">+ Add to Queue</button><span style="color:var(--text-muted);font-size:13px">Queue is empty.</span></div>';
    panel.querySelector('#queue-add-btn').addEventListener('click', () => openJobModal(null, { queued: true }));
    return;
  }

  const isDayView = view === 'day';
  let h = `<div class="queue-panel-inner"><span class="queue-panel-title">Print Queue (${count})</span><button class="btn btn-primary btn-sm" id="queue-add-btn">+ Add to Queue</button><div class="queue-list">`;
  queued.forEach(job => {
    const p = printers.find(pr => pr.id === job.printerId);
    const printerChip = p
      ? `<span class="queue-printer-chip" style="background:${hexRgba(p.color,.15)};color:${p.color};border-color:${hexRgba(p.color,.4)}">${escHtml(p.name)}</span>`
      : '';
    const meta = [job.customerName, job.orderNr ? `#${job.orderNr}` : ''].filter(Boolean).join(' · ');
    const dur = job.durationMins ?? 0;
    const durH = Math.floor(dur / 60), durM = dur % 60;
    const durStr = dur > 0 ? (durH > 0 ? (durM > 0 ? `${durH}h ${durM}m` : `${durH}h`) : `${durM}m`) : '';
    const durChip = durStr ? `<span class="queue-dur-chip">${durStr}</span>` : '';
    const dragHint = isDayView ? ' queue-item-draggable' : '';
    const dragTitle = isDayView ? ' title="Drag to calendar to schedule"' : '';
    h += `<div class="queue-item${dragHint}" data-id="${job.id}" data-duration="${dur}" data-printer="${job.printerId ?? ''}"${dragTitle}>
      ${isDayView ? '<span class="queue-drag-handle" title="Drag to schedule">⠿</span>' : ''}
      <div class="queue-item-info">
        <span class="queue-item-name">${escHtml(job.name)}</span>
        ${meta ? `<span class="queue-item-meta">${escHtml(meta)}</span>` : ''}
        ${printerChip}
        ${durChip}
      </div>
      <div class="queue-item-actions">
        <button class="btn btn-primary btn-sm queue-schedule-btn" data-id="${job.id}">Schedule</button>
        <button class="btn btn-secondary btn-sm queue-edit-btn"   data-id="${job.id}">Edit</button>
        <button class="btn-icon danger queue-delete-btn"           data-id="${job.id}" title="Remove">🗑</button>
      </div>
    </div>`;
  });
  h += '</div></div>';
  panel.innerHTML = h;

  panel.querySelector('#queue-add-btn')?.addEventListener('click', () => openJobModal(null, { queued: true }));

  panel.querySelectorAll('.queue-schedule-btn').forEach(btn =>
    btn.addEventListener('click', () => scheduleFromQueue(parseInt(btn.dataset.id)))
  );
  panel.querySelectorAll('.queue-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openJobModal(parseInt(btn.dataset.id)))
  );
  panel.querySelectorAll('.queue-delete-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      if (!confirm('Remove from queue?')) return;
      await api('DELETE', `/api/jobs/${btn.dataset.id}`);
      renderCalendar();
    })
  );

  // Drag-to-schedule (day view only)
  if (isDayView) {
    panel.querySelectorAll('.queue-item-draggable').forEach(item => {
      item.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (e.target.closest('button')) return; // don't hijack button clicks
        e.preventDefault();
        const jobId       = parseInt(item.dataset.id);
        const durationMins = parseInt(item.dataset.duration) || 60;
        const ghostEl     = document.createElement('div');
        ghostEl.className = 'queue-drag-ghost';
        ghostEl.textContent = item.querySelector('.queue-item-name').textContent;
        const durD = item.querySelector('.queue-dur-chip');
        if (durD) ghostEl.textContent += '  ' + durD.textContent;
        document.body.appendChild(ghostEl);
        ghostEl.style.left = (e.clientX + 14) + 'px';
        ghostEl.style.top  = (e.clientY - 10) + 'px';
        drag = { type: 'queue-schedule', jobId, durationMins, ghostEl, previewEl: null, colEl: null, printerId: null, currentMins: null, moved: false };
        document.body.classList.add('is-dragging');
      });
    });
  }
}

async function scheduleFromQueue(jobId) {
  // Open the modal as a normal edit — but override queued=false so time fields show,
  // and focus the start time after open.
  await openJobModal(jobId, { _scheduleMode: true });
}

// =============================================================================
// Day view
// =============================================================================
async function renderDay() {
  const container = document.getElementById('calendar-container');
  if (!printers.length) { renderEmpty(container); return; }

  const dayS = new Date(navDate); dayS.setHours(0,0,0,0);
  const allJobs      = await api('GET', '/api/jobs');
  const scheduledJobs = allJobs.filter(j => !j.queued);
  const jobs          = scheduledJobs.filter(j => overlapsDay(j, navDate));

  // Populate jobs cache
  allJobs.forEach(j => { jobsCache[j.id] = j; });

  // Detect conflicts across scheduled jobs only
  const conflictIds = detectConflicts(scheduledJobs);

  const dayClosure = closureForDay(navDate);

  // ---- Build HTML ----
  let h = '<div class="day-view">';

  // Header (printer columns)
  h += '<div class="day-view-header">';
  h += '<div class="day-time-gutter-header"></div>';
  printers.forEach(p => {
    h += `<div class="day-printer-header" style="color:${p.color}">${escHtml(p.name)}</div>`;
  });
  h += '</div>';

  // Closure banner
  if (dayClosure) {
    const lbl = escHtml(dayClosure.label || 'Closed');
    h += `<div class="day-closed-banner">🔒 ${lbl} — no jobs can be scheduled on this day</div>`;
  }

  // Scrollable body
  h += `<div class="day-view-scroll" id="day-scroll">`;
  h += `<div class="day-view-body" style="height:${DAY_MINS}px">`;

  // Time gutter
  h += '<div class="day-time-gutter">';
  for (let hr = DAY_START; hr < DAY_END; hr++) {
    const top = (hr - DAY_START) * HOUR_HEIGHT;
    h += `<div class="time-label" style="top:${top}px">${String(hr).padStart(2,'0')}:00</div>`;
  }
  h += '</div>';

  // One column per printer
  printers.forEach(p => {
    h += `<div class="day-printer-col${dayClosure ? ' day-col-closed' : ''}" data-printer-id="${p.id}">`;
    if (dayClosure) h += '<div class="day-closed-overlay"></div>';

    // Hour + half-hour grid lines
    for (let hr = DAY_START; hr < DAY_END; hr++) {
      const top = (hr - DAY_START) * HOUR_HEIGHT;
      h += `<div class="hour-line"      style="top:${top}px"></div>`;
      h += `<div class="half-hour-line" style="top:${top + HOUR_HEIGHT/2}px"></div>`;
    }

    // Job blocks
    jobs.filter(j => j.printerId === p.id).forEach(job => {
      const start = new Date(job.start);
      const end   = new Date(job.end);
      // Clamp to day boundaries using ms arithmetic (avoids midnight roll-over bugs)
      const startMins = (start.getTime() - dayS.getTime()) / 60_000;
      const endMins   = (end.getTime()   - dayS.getTime()) / 60_000;
      const topPx  = Math.max(0, startMins);           // 1 min = 1 px at HOUR_HEIGHT=60
      const htPx   = Math.max(Math.min(endMins, DAY_MINS) - topPx, 18);

      const status     = job.status ?? 'Planned';
      const isConflict = conflictIds.has(job.id);
      const conflictCls  = isConflict ? ' job-conflict' : '';
      const conflictIcon = isConflict ? '<span class="job-conflict-icon" title="Scheduling conflict">⚠</span>' : '';

      h += `<div class="job-block${conflictCls}" data-job-id="${job.id}"
              data-job-start="${job.start}" data-job-end="${job.end}"
              style="top:${topPx}px; height:${htPx}px;
                     background:${hexRgba(p.color, .15)};
                     border-left-color:${isConflict ? '#e53e3e' : p.color};
                     color:#2d3748">
              <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
                ${conflictIcon}
                <span class="job-block-name" style="flex:1">${job.orderNr ? `#${escHtml(job.orderNr)} — ` : ''}${escHtml(job.name)}</span>
                <span class="job-status-badge" style="${statusBadgeStyle(status)}">${escHtml(status)}</span>
              </div>`;
      if (job.customerName) h += `<span class="job-block-customer">${escHtml(job.customerName)}</span>`;
      h += '<div class="job-resize-handle"></div>';
      h += '</div>';
    });

    h += '</div>'; // .day-printer-col
  });

  h += '</div>'; // .day-view-body
  h += '</div>'; // .day-view-scroll
  h += '</div>'; // .day-view

  container.innerHTML = h;

  // Now-line
  if (sameDay(new Date(), navDate)) {
    const now    = new Date();
    const nowPx  = now.getHours() * 60 + now.getMinutes();
    document.querySelectorAll('.day-printer-col').forEach(col => {
      const line = document.createElement('div');
      line.className = 'now-line';
      line.style.top = `${nowPx}px`;
      col.appendChild(line);
    });
  }

  attachDayEvents();
}

// Snap a pixel offset (= minutes at HOUR_HEIGHT=60) to the nearest 15-min boundary.
function snap15(px) { return Math.round(px / 15) * 15; }

function updateDragPreview() {
  if (!drag) return;
  const { anchorMins, currentMins, previewEl, printerId } = drag;
  const startMins = Math.min(anchorMins, currentMins);
  const endMins   = Math.max(Math.max(anchorMins, currentMins), startMins + 15);
  const durMins   = endMins - startMins;
  const printer   = printers.find(p => p.id === printerId);
  const color     = printer?.color ?? '#0f766e';

  previewEl.style.top             = startMins + 'px';
  previewEl.style.height          = durMins + 'px';
  previewEl.style.background      = hexRgba(color, 0.22);
  previewEl.style.borderLeftColor = color;

  const h = Math.floor(durMins / 60), m = durMins % 60;
  previewEl.textContent = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function onDragMove(e) {
  if (!drag) return;

  if (drag.type === 'queue-schedule') {
    drag.moved = true;
    drag.ghostEl.style.left = (e.clientX + 14) + 'px';
    drag.ghostEl.style.top  = (e.clientY - 10) + 'px';

    let targetCol = null;
    document.querySelectorAll('.day-printer-col').forEach(col => {
      const r = col.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)
        targetCol = col;
    });

    if (targetCol) {
      const rect  = targetCol.getBoundingClientRect();
      const y     = snap15(Math.max(0, Math.min(e.clientY - rect.top, DAY_MINS - drag.durationMins)));
      drag.currentMins = y;
      drag.printerId   = parseInt(targetCol.dataset.printerId);

      if (drag.colEl !== targetCol) {
        if (drag.previewEl) drag.previewEl.remove();
        const prev = document.createElement('div');
        prev.className = 'drag-preview';
        targetCol.appendChild(prev);
        drag.previewEl = prev;
        drag.colEl = targetCol;
      }

      const { durationMins, previewEl } = drag;
      const printer = printers.find(p => p.id === drag.printerId);
      const color   = printer?.color ?? '#0f766e';
      previewEl.style.top             = y + 'px';
      previewEl.style.height          = durationMins + 'px';
      previewEl.style.background      = hexRgba(color, 0.22);
      previewEl.style.borderLeftColor = color;
      const h = Math.floor(durationMins / 60), m = durationMins % 60;
      previewEl.textContent = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
    } else {
      if (drag.previewEl) { drag.previewEl.remove(); drag.previewEl = null; drag.colEl = null; }
      drag.currentMins = null;
      drag.printerId   = null;
    }
    return;
  }

  if (drag.type === 'create') {
    const rect = drag.colEl.getBoundingClientRect();
    const y = Math.max(0, Math.min(e.clientY - rect.top, DAY_MINS));
    drag.currentMins = snap15(y);
    if (Math.abs(drag.currentMins - drag.anchorMins) >= 15) drag.moved = true;
    updateDragPreview();
    return;
  }

  const rect = drag.colEl.getBoundingClientRect();
  const y    = snap15(Math.max(0, Math.min(e.clientY - rect.top, DAY_MINS)));

  if (drag.type === 'move') {
    const newTop = Math.max(0, Math.min(y - drag.offsetMins, DAY_MINS - drag.durationMins));
    if (Math.abs(newTop - drag.currentTopMins) >= 1) drag.moved = true;
    drag.currentTopMins = newTop;
    drag.jobEl.style.top = newTop + 'px';
    drag.jobEl.style.opacity = '0.75';
    drag.jobEl.style.zIndex  = '10';
  } else if (drag.type === 'resize') {
    const newEnd = Math.max(drag.startMins + 15, Math.min(y, DAY_MINS));
    if (Math.abs(newEnd - drag.currentEndMins) >= 1) drag.moved = true;
    drag.currentEndMins = newEnd;
    drag.jobEl.style.height  = (newEnd - drag.startMins) + 'px';
    drag.jobEl.style.opacity = '0.75';
  }
}

async function onDragEnd() {
  if (!drag) return;

  if (drag.type === 'queue-schedule') {
    const { jobId, durationMins, currentMins, printerId, ghostEl, previewEl } = drag;
    ghostEl.remove();
    if (previewEl) previewEl.remove();
    document.body.classList.remove('is-dragging');
    drag = null;

    if (currentMins === null || printerId === null) return; // dropped outside grid

    const job = jobsCache[jobId];
    if (!job) return;
    const start = new Date(navDate);
    start.setHours(Math.floor(currentMins / 60), currentMins % 60, 0, 0);
    const end = new Date(start.getTime() + durationMins * 60_000);

    await api('PUT', `/api/jobs/${jobId}`, {
      printerId,
      name:         job.name,
      customerName: job.customerName,
      orderNr:      job.orderNr,
      colors:       job.colors,
      printFile:    job.printFile,
      remarks:      job.remarks,
      status:       job.status ?? 'Planned',
      start:        toDatetimeLocal(start),
      end:          toDatetimeLocal(end),
      queued:       false,
      durationMins,
    });

    await renderCalendar();
    const scr = document.getElementById('day-scroll');
    if (scr) scr.scrollTop = Math.max(0, currentMins - 120);
    return;
  }

  if (drag.type === 'create') {
    const { printerId, anchorMins, currentMins, moved, previewEl } = drag;
    previewEl.remove();
    document.body.classList.remove('is-dragging');
    drag = null;

    if (!moved) {
      const start = new Date(navDate);
      start.setHours(Math.floor(anchorMins / 60), anchorMins % 60, 0, 0);
      const end = new Date(start.getTime() + 3_600_000);
      openJobModal(null, { printerId, start: toDatetimeLocal(start), end: toDatetimeLocal(end) });
      return;
    }

    const startMins = Math.min(anchorMins, currentMins);
    const endMins   = Math.max(Math.max(anchorMins, currentMins), startMins + 15);
    const start = new Date(navDate);
    start.setHours(Math.floor(startMins / 60), startMins % 60, 0, 0);
    const end = new Date(navDate);
    end.setHours(Math.floor(endMins / 60), endMins % 60, 0, 0);
    openJobModal(null, { printerId, start: toDatetimeLocal(start), end: toDatetimeLocal(end) });
    return;
  }

  // move or resize
  const { type, jobId, job, moved, currentTopMins, currentEndMins, startMins, jobEl } = drag;
  jobEl.style.opacity = '';
  jobEl.style.zIndex  = '';
  document.body.classList.remove('is-moving', 'is-resizing');
  const wasMoved = moved;
  drag = null;

  if (!wasMoved) return;
  lastDragMoved = true;

  const scr = document.getElementById('day-scroll');
  if (scr) savedScrollTop = scr.scrollTop;

  if (type === 'move') {
    const newStart = new Date(navDate);
    newStart.setHours(Math.floor(currentTopMins / 60), currentTopMins % 60, 0, 0);
    const durMs  = new Date(job.end) - new Date(job.start);
    const newEnd = new Date(newStart.getTime() + durMs);
    await api('PATCH', `/api/jobs/${jobId}`, { start: toDatetimeLocal(newStart), end: toDatetimeLocal(newEnd) });
  } else if (type === 'resize') {
    const newEnd = new Date(navDate);
    newEnd.setHours(Math.floor(currentEndMins / 60), currentEndMins % 60, 0, 0);
    await api('PATCH', `/api/jobs/${jobId}`, { end: toDatetimeLocal(newEnd) });
  }

  await renderCalendar();
  const scr2 = document.getElementById('day-scroll');
  if (scr2) scr2.scrollTop = savedScrollTop;
}

function attachDayEvents() {
  // Click job → edit  |  right-click → context menu  |  mousedown → move
  document.querySelectorAll('.job-block').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      if (lastDragMoved) { lastDragMoved = false; return; }
      openJobModal(parseInt(el.dataset.jobId));
    });
    el.addEventListener('contextmenu', e => showCtxMenu(e, parseInt(el.dataset.jobId)));

    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('.job-resize-handle')) return;
      e.stopPropagation();

      const jobId   = parseInt(el.dataset.jobId);
      const job     = jobsCache[jobId];
      if (!job) return;
      const colEl   = el.closest('.day-printer-col');
      const colRect = colEl.getBoundingClientRect();
      const elRect  = el.getBoundingClientRect();
      const topMins = elRect.top - colRect.top;

      drag = {
        type: 'move',
        jobEl: el,
        jobId,
        colEl,
        job,
        offsetMins: snap15(e.clientY - elRect.top),
        currentTopMins: topMins,
        durationMins: Math.round((new Date(job.end) - new Date(job.start)) / 60_000),
        moved: false,
      };
      document.body.classList.add('is-moving');
      e.preventDefault();
    });
  });

  // Resize handles
  document.querySelectorAll('.job-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();

      const jobEl  = handle.closest('.job-block');
      const jobId  = parseInt(jobEl.dataset.jobId);
      const job    = jobsCache[jobId];
      if (!job) return;
      const colEl  = jobEl.closest('.day-printer-col');
      const colRect = colEl.getBoundingClientRect();
      const elRect  = jobEl.getBoundingClientRect();
      const startMins = elRect.top - colRect.top;

      drag = {
        type: 'resize',
        jobEl,
        jobId,
        colEl,
        job,
        startMins,
        currentEndMins: elRect.bottom - colRect.top,
        moved: false,
      };
      document.body.classList.add('is-resizing');
      e.preventDefault();
    });
  });

  // Mousedown on empty column → start drag-to-create (blocked on closed days)
  document.querySelectorAll('.day-printer-col').forEach(col => {
    col.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.closest('.job-block')) return;
      if (isDayClosed(navDate)) return; // closed day — no new jobs
      const rect       = col.getBoundingClientRect();
      const anchorMins = snap15(Math.max(0, e.clientY - rect.top));
      const previewEl  = document.createElement('div');
      previewEl.className = 'drag-preview';
      col.appendChild(previewEl);
      drag = {
        type: 'create',
        printerId: parseInt(col.dataset.printerId),
        anchorMins,
        currentMins: anchorMins,
        previewEl,
        colEl: col,
        moved: false,
      };
      updateDragPreview();
      document.body.classList.add('is-dragging');
      e.preventDefault();
    });
  });
}

function scrollToNow() {
  const scroll = document.getElementById('day-scroll');
  if (!scroll) return;
  const now = new Date();
  scroll.scrollTop = Math.max(0, now.getHours() * HOUR_HEIGHT - 120);
}

// =============================================================================
// Week view
// =============================================================================
async function renderWeek() {
  const container = document.getElementById('calendar-container');
  if (!printers.length) { renderEmpty(container); return; }

  const ws   = weekStart(navDate);
  const days = Array.from({length:7}, (_,i) => addDays(ws,i));
  const re   = addDays(days[6], 1);

  const allJobs  = await api('GET', '/api/jobs');
  const weekJobs = allJobs.filter(j => !j.queued && overlapsRange(j, ws, re));
  allJobs.forEach(j => { jobsCache[j.id] = j; });
  const today    = todayMidnight();

  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  let h = '<div class="week-view"><table class="week-table"><thead><tr>';
  h += '<th></th>';
  days.forEach(d => {
    const closed = isDayClosed(d);
    const cl = closureForDay(d);
    let cls = sameDay(d, today) ? 'today-col' : '';
    if (closed) cls += (cls ? ' ' : '') + 'week-closed-col';
    const clsAttr = cls ? ` class="${cls}"` : '';
    const closedLabel = closed ? `<div class="week-closed-label">🔒 ${escHtml(cl?.label || 'Closed')}</div>` : '';
    h += `<th${clsAttr}>${DAY_NAMES[d.getDay()]} ${fmtDate(d,'D/MM')}${closedLabel}</th>`;
  });
  h += '</tr></thead><tbody>';

  printers.forEach(p => {
    h += '<tr>';
    h += `<td class="week-printer-label">
            <span style="display:inline-flex;align-items:center;gap:6px">
              <span style="width:10px;height:10px;border-radius:50%;background:${p.color};flex-shrink:0"></span>
              ${escHtml(p.name)}
            </span>
          </td>`;
    days.forEach(d => {
      const closed = isDayClosed(d);
      let cls = sameDay(d, today) ? 'today-col' : '';
      if (closed) cls += (cls ? ' ' : '') + 'week-closed-col';
      h += `<td class="${cls}"${closed ? '' : ` data-printer-id="${p.id}" data-date="${toDateKey(d)}"`}>`;
      weekJobs
        .filter(j => j.printerId === p.id && overlapsDay(j, d))
        .forEach(job => {
          const status    = job.status ?? 'Planned';
          const statusCol = statusMeta[status]?.color ?? '#888';
          h += `<span class="week-job-chip" data-job-id="${job.id}"
                  style="background:${hexRgba(p.color,.18)};
                         color:${darken(p.color,.3)};
                         border-left-color:${p.color}">
                  <span class="chip-status-dot" style="background:${statusCol}"></span>${job.orderNr ? `#${escHtml(job.orderNr)} — ` : ''}${escHtml(job.name)}
                </span>`;
        });
      h += '</td>';
    });
    h += '</tr>';
  });

  h += '</tbody></table></div>';
  container.innerHTML = h;

  // Click chip → edit  |  right-click → context menu
  document.querySelectorAll('.week-job-chip').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      openJobModal(parseInt(el.dataset.jobId));
    });
    el.addEventListener('contextmenu', e => showCtxMenu(e, parseInt(el.dataset.jobId)));
  });

  // Click cell → new job
  document.querySelectorAll('.week-view td[data-date]').forEach(td => {
    td.addEventListener('click', e => {
      if (e.target.closest('.week-job-chip')) return;
      const start = new Date(td.dataset.date + 'T09:00');
      const end   = new Date(start.getTime() + 3_600_000);
      openJobModal(null, {
        printerId: parseInt(td.dataset.printerId),
        start: toDatetimeLocal(start),
        end:   toDatetimeLocal(end),
      });
    });
  });
}

// =============================================================================
// Month view
// =============================================================================
async function renderMonth() {
  const container = document.getElementById('calendar-container');

  const year  = navDate.getFullYear();
  const month = navDate.getMonth();
  const first = new Date(year, month, 1);
  const last  = new Date(year, month + 1, 0);
  const gs    = weekStart(first);
  const rows  = Math.ceil(((first.getDay() === 0 ? 7 : first.getDay() - 1) + last.getDate()) / 7);
  const days  = Array.from({length: rows * 7}, (_,i) => addDays(gs, i));
  const ge    = addDays(days[days.length - 1], 1);

  const allJobs   = await api('GET', '/api/jobs');
  const monthJobs = allJobs.filter(j => !j.queued && overlapsRange(j, gs, ge));
  allJobs.forEach(j => { jobsCache[j.id] = j; });
  const today     = todayMidnight();

  let h = '<div class="month-view"><div class="month-grid">';
  ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(n => {
    h += `<div class="month-day-header">${n}</div>`;
  });

  days.forEach(d => {
    const isToday   = sameDay(d, today);
    const isCurr    = d.getMonth() === month;
    const cl        = closureForDay(d);
    let cls = 'month-day-cell';
    if (isToday) cls += ' today';
    if (!isCurr) cls += ' other-month';
    if (cl)      cls += ' month-day-closed';

    h += `<div class="${cls}" data-date="${toDateKey(d)}">`;
    h += '<div class="month-day-number">';
    if (isToday) h += `<span class="month-today-number">${d.getDate()}</span>`;
    else         h += d.getDate();
    h += '</div>';

    // Closure all-day chip
    if (cl) {
      h += `<div class="month-closure-chip" title="${escHtml(cl.label || 'Closed')}">🔒 ${escHtml(cl.label || 'Closed')}</div>`;
    }

    monthJobs.filter(j => overlapsDay(j, d)).forEach(job => {
      const p = printers.find(pr => pr.id === job.printerId);
      if (!p) return;
      const status    = job.status ?? 'Planned';
      const statusCol = statusMeta[status]?.color ?? '#888';
      h += `<span class="month-job-chip" data-job-id="${job.id}"
               style="background:${hexRgba(p.color,.18)};
                      color:${darken(p.color,.3)};
                      border-left-color:${p.color}">
               <span class="chip-status-dot" style="background:${statusCol}"></span>${job.orderNr ? `#${escHtml(job.orderNr)} — ` : ''}${escHtml(job.name)}${job.customerName ? `<span class="month-chip-customer"> · ${escHtml(job.customerName)}</span>` : ''}
             </span>`;
    });
    h += '</div>';
  });

  h += '</div></div>';
  container.innerHTML = h;

  // Click chip → edit  |  right-click → context menu
  document.querySelectorAll('.month-job-chip').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      openJobModal(parseInt(el.dataset.jobId));
    });
    el.addEventListener('contextmenu', e => showCtxMenu(e, parseInt(el.dataset.jobId)));
  });

  document.querySelectorAll('.month-day-cell').forEach(cell => {
    cell.addEventListener('click', e => {
      if (e.target.closest('.month-job-chip')) return;
      navDate = new Date(cell.dataset.date + 'T00:00:00');
      view    = 'day';
      renderCalendar();
      setTimeout(scrollToNow, 80);
    });
  });
}

// =============================================================================
// Upcoming view
// =============================================================================
async function renderUpcoming() {
  const container = document.getElementById('calendar-container');
  if (!printers.length) { renderEmpty(container); return; }

  const allJobs = await api('GET', '/api/jobs');
  allJobs.forEach(j => { jobsCache[j.id] = j; });

  const today = todayMidnight();
  const upcoming = allJobs
    .filter(j => !j.queued && new Date(j.end) >= today)
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  // Group by date key
  const grouped = {};
  upcoming.forEach(j => {
    const key = toDateKey(new Date(j.start));
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(j);
  });

  const p2 = n => String(n).padStart(2, '0');
  const fmtTime = d => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

  let h = '<div class="upcoming-view">';

  if (!Object.keys(grouped).length) {
    h += '<div class="upcoming-empty">No upcoming jobs scheduled.</div>';
  } else {
    Object.keys(grouped).sort().forEach(key => {
      const day = new Date(key + 'T00:00:00');
      const closure = closureForDay(day);
      const isToday = toDateKey(day) === toDateKey(new Date());
      h += `<div class="upcoming-day-section">`;
      h += `<div class="upcoming-day-header${isToday ? ' upcoming-day-today' : ''}">${fmtDate(day, 'DDDD, D MMMM YYYY')}</div>`;
      if (closure) {
        h += `<div class="closure-banner">🔒 Closed${closure.label ? ': ' + escHtml(closure.label) : ''}</div>`;
      }
      grouped[key].forEach(job => {
        const printer = printers.find(p => p.id === job.printerId);
        const start = new Date(job.start);
        const end   = new Date(job.end);
        const sc    = statusMeta[job.status]?.color ?? '#888';
        const dur   = Math.round((end - start) / 60000);
        const durTxt = dur >= 60 ? `${Math.floor(dur/60)}h${dur%60 ? ` ${dur%60}m` : ''}` : `${dur}m`;
        h += `<div class="upcoming-job-row" data-job-id="${job.id}" style="border-left-color:${escHtml(printer?.color ?? '#888')}">`;
        h += `<div class="upcoming-job-time">${fmtTime(start)} – ${fmtTime(end)}<span class="upcoming-dur-chip">${durTxt}</span></div>`;
        h += `<div class="upcoming-job-info">`;
        h += `<span class="upcoming-job-name">${escHtml(job.name)}</span>`;
        if (job.customerName) h += `<span class="upcoming-job-customer"> · ${escHtml(job.customerName)}</span>`;
        if (job.orderNr)      h += `<span class="upcoming-job-ordernr"> #${escHtml(job.orderNr)}</span>`;
        h += `</div>`;
        h += `<div class="upcoming-job-meta">`;
        if (printer) h += `<span class="upcoming-printer-chip" style="background:${escHtml(printer.color)}20;color:${escHtml(printer.color)}">${escHtml(printer.name)}</span>`;
        h += `<span class="upcoming-status-chip" style="background:${sc}20;color:${sc}">${escHtml(job.status)}</span>`;
        h += `</div>`;
        h += `</div>`;
      });
      h += `</div>`;
    });
  }

  h += '</div>';
  container.innerHTML = h;

  container.querySelectorAll('.upcoming-job-row[data-job-id]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      openJobModal(parseInt(el.dataset.jobId));
    });
    el.addEventListener('contextmenu', e => showCtxMenu(e, parseInt(el.dataset.jobId)));
  });
}

// =============================================================================
// Empty state
// =============================================================================
function renderEmpty(container) {
  container.innerHTML = `
    <div class="empty-state">
      <div style="font-size:52px">🖨</div>
      <h2>No printers configured</h2>
      <p>Add your first printer to start scheduling print jobs.</p>
      <button class="btn btn-primary" onclick="openPrintersModal()">⚙ Manage Printers</button>
    </div>`;
}

// =============================================================================
// Context menu
// =============================================================================
function showCtxMenu(e, jobId) {
  e.preventDefault();
  e.stopPropagation();
  ctxJobId = jobId;

  // Mark active status
  const currentStatus = jobsCache[jobId]?.status ?? 'Planned';
  document.querySelectorAll('.ctx-status-btn').forEach(btn =>
    btn.classList.toggle('ctx-status-active', btn.dataset.status === currentStatus)
  );

  const menu = document.getElementById('ctx-menu');
  menu.style.left = e.clientX + 'px';
  menu.style.top  = e.clientY + 'px';
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  if (rect.right  > window.innerWidth)  menu.style.left = (e.clientX - rect.width)  + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top  = (e.clientY - rect.height) + 'px';
}

function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.add('hidden');
  ctxJobId = null;
}

// =============================================================================
// Job modal
// =============================================================================

// Switch between duration and end-date input modes.
// When switching to duration mode, derives h/m from startVal+endVal if available.
// When switching to end-date mode, caller must pre-populate #job-end before calling.
function setEndMode(mode, startVal, endVal) {
  const isDur = mode === 'duration';
  document.getElementById('toggle-duration').classList.toggle('active',  isDur);
  document.getElementById('toggle-enddate') .classList.toggle('active', !isDur);
  document.getElementById('end-duration-row').classList.toggle('hidden', !isDur);
  document.getElementById('end-enddate-row') .classList.toggle('hidden',  isDur);

  if (isDur) {
    const s = new Date(startVal), e = new Date(endVal);
    if (startVal && endVal && !isNaN(s) && !isNaN(e) && e > s) {
      const total = Math.round((e - s) / 60_000);
      document.getElementById('job-duration-h').value = Math.floor(total / 60);
      document.getElementById('job-duration-m').value = total % 60;
    } else {
      document.getElementById('job-duration-h').value = 1;
      document.getElementById('job-duration-m').value = 0;
    }
  }
}

function setJobStatus(status) {
  document.querySelectorAll('.status-btn').forEach(btn => {
    const isActive = btn.dataset.status === status;
    btn.classList.toggle('active', isActive);
    if (isActive) {
      const color = statusMeta[btn.dataset.status]?.color ?? '#888';
      btn.style.background  = hexRgba(color, 0.15);
      btn.style.color       = color;
      btn.style.borderColor = color;
    } else {
      btn.style.background  = '';
      btn.style.color       = '';
      btn.style.borderColor = '';
    }
  });
}

function getJobStatus() {
  return document.querySelector('.status-btn.active')?.dataset.status ?? 'Planned';
}

async function duplicateJob(jobId) {
  const job = await api('GET', `/api/jobs/${jobId}`);
  if (!job) return;
  openJobModal(null, {
    printerId:    job.printerId,
    name:         job.name + ' (copy)',
    start:        job.queued ? '' : job.start,
    end:          job.queued ? '' : job.end,
    customerName: job.customerName,
    orderNr:      job.orderNr,
    colors:       job.colors,
    printFile:    job.printFile,
    remarks:      job.remarks,
    status:       job.status,
    queued:       job.queued,
  });
}

function setQueuedMode(isQueued) {
  document.getElementById('job-queued').checked = isQueued;
  document.getElementById('job-queue-section').classList.toggle('hidden', !isQueued);
  document.getElementById('job-schedule-section').classList.toggle('hidden', isQueued);
  document.getElementById('btn-save-job').textContent = isQueued ? 'Save to Queue' : 'Save';
}

async function openJobModal(jobId = null, prefill = {}) {
  editJobId = jobId;

  // Save current scroll position so we can restore it after save/delete
  const scroller = document.getElementById('day-scroll');
  if (scroller) savedScrollTop = scroller.scrollTop;

  const sel = document.getElementById('job-printer');
  sel.innerHTML = printers.map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join('');

  const title  = document.getElementById('job-modal-title');
  const delBtn = document.getElementById('btn-delete-job');
  let startVal = '', endVal = '';
  // _scheduleMode: open a queued job in schedule-mode (time fields visible, queued=false)
  const scheduleMode = !!prefill._scheduleMode;

  if (jobId !== null) {
    const job = await api('GET', `/api/jobs/${jobId}`);
    if (!job) return;
    const isQueued = job.queued && !scheduleMode;
    title.textContent = scheduleMode ? 'Schedule Job' : isQueued ? 'Edit Queued Job' : 'Edit Print Job';
    delBtn.classList.remove('hidden');
    document.getElementById('job-name').value      = job.name        ?? '';
    sel.value                                       = job.printerId;
    if (!isQueued && job.start) {
      startVal = toDatetimeLocal(new Date(job.start));
      endVal   = toDatetimeLocal(new Date(job.end));
    }
    document.getElementById('job-start').value     = startVal;
    document.getElementById('job-customer').value  = job.customerName ?? '';
    document.getElementById('job-ordernr').value   = job.orderNr      ?? '';
    document.getElementById('job-colors').value    = job.colors       ?? '';
    document.getElementById('job-printfile').value = job.printFile    ?? '';
    document.getElementById('job-remarks').value   = job.remarks      ?? '';
    editingJobStatus = job.status ?? 'Planned';
    setQueuedMode(isQueued);
    // Populate queue duration fields
    const dur = job.durationMins ?? 0;
    document.getElementById('job-queue-dur-h').value = Math.floor(dur / 60);
    document.getElementById('job-queue-dur-m').value = dur % 60;
    // In schedule mode pre-fill the schedule duration from durationMins
    if (scheduleMode && dur > 0) {
      document.getElementById('job-duration-h').value = Math.floor(dur / 60);
      document.getElementById('job-duration-m').value = dur % 60;
    }
  } else {
    const isQueued = !!prefill.queued;
    title.textContent = isQueued ? 'Add to Queue' : 'Add Print Job';
    delBtn.classList.add('hidden');
    document.getElementById('job-name').value      = prefill.name      ?? '';
    if (prefill.printerId) sel.value = prefill.printerId;
    startVal = typeof prefill.start === 'string' ? prefill.start
             : prefill.start ? toDatetimeLocal(new Date(prefill.start)) : '';
    endVal   = typeof prefill.end   === 'string' ? prefill.end
             : prefill.end   ? toDatetimeLocal(new Date(prefill.end))   : '';
    document.getElementById('job-start').value     = startVal;
    document.getElementById('job-end').value       = endVal;
    document.getElementById('job-customer').value  = prefill.customerName ?? '';
    document.getElementById('job-ordernr').value   = prefill.orderNr      ?? '';
    document.getElementById('job-colors').value    = prefill.colors       ?? '';
    document.getElementById('job-printfile').value = prefill.printFile    ?? '';
    document.getElementById('job-remarks').value   = prefill.remarks      ?? '';
    editingJobStatus = prefill.status ?? 'Planned';
    setQueuedMode(isQueued);
  }

  // Populate customer suggestions from past jobs
  const allJobs   = await api('GET', '/api/jobs');
  const customers = [...new Set(allJobs.map(j => j.customerName).filter(n => n?.trim()))];
  document.getElementById('customer-suggestions').innerHTML =
    customers.map(c => `<option value="${escHtml(c)}">`).join('');

  // Always open in duration mode; derive h/m from start+end when available
  setEndMode('duration', startVal, endVal);

  document.getElementById('job-modal').classList.remove('hidden');
  if (scheduleMode) document.getElementById('job-start').focus();
  else document.getElementById('job-name').focus();
}

async function saveJob() {
  const wasEditing   = editJobId !== null;
  const isQueued     = document.getElementById('job-queued').checked;
  const name         = document.getElementById('job-name').value.trim();
  const printerId    = parseInt(document.getElementById('job-printer').value);
  const customerName = document.getElementById('job-customer').value.trim();
  const orderNr      = document.getElementById('job-ordernr').value.trim();
  const colors       = document.getElementById('job-colors').value.trim();
  const printFile    = document.getElementById('job-printfile').value.trim();
  const remarks      = document.getElementById('job-remarks').value.trim();
  const status       = editingJobStatus;

  if (!name)      return alert('Please enter a job name.');
  if (!printerId) return alert('Please select a printer.');

  if (isQueued) {
    const qh = parseInt(document.getElementById('job-queue-dur-h').value) || 0;
    const qm = parseInt(document.getElementById('job-queue-dur-m').value) || 0;
    if (qh === 0 && qm === 0) return alert('Please enter an expected duration.');
    const durationMins = qh * 60 + qm;
    const data = { printerId, name, customerName, orderNr, colors, printFile, remarks, status, queued: true, durationMins };
    if (wasEditing) await api('PUT', `/api/jobs/${editJobId}`, data);
    else            await api('POST', '/api/jobs', data);
    closeModal('job-modal');
    renderCalendar();
    return;
  }

  const start = document.getElementById('job-start').value;
  if (!start) return alert('Please set a start time.');

  let end;
  const durationMode = !document.getElementById('end-duration-row').classList.contains('hidden');
  if (durationMode) {
    const h = parseInt(document.getElementById('job-duration-h').value) || 0;
    const m = parseInt(document.getElementById('job-duration-m').value) || 0;
    if (h === 0 && m === 0) return alert('Please enter a duration greater than 0.');
    end = toDatetimeLocal(new Date(new Date(start).getTime() + (h * 60 + m) * 60_000));
  } else {
    end = document.getElementById('job-end').value;
    if (!end) return alert('Please set an end time.');
    if (new Date(end) <= new Date(start)) return alert('End time must be after start time.');
  }

  // Closure check: walk each calendar day covered by the job
  {
    let cur = new Date(start); cur.setHours(0, 0, 0, 0);
    const last = new Date(end); last.setHours(0, 0, 0, 0);
    while (cur <= last) {
      const cl = closureForDay(cur);
      if (cl) {
        return alert(`This job overlaps a closure period${cl.label ? ` (${cl.label})` : ''}. Please choose different dates.`);
      }
      cur = addDays(cur, 1);
    }
  }

  const data = { printerId, name, customerName, orderNr, colors, printFile, remarks, start, end, status, queued: false };
  if (wasEditing) await api('PUT', `/api/jobs/${editJobId}`, data);
  else            await api('POST', '/api/jobs', data);

  closeModal('job-modal');

  if (view !== 'day') { renderCalendar(); return; }

  const jobStart = new Date(start);
  const jobEnd   = new Date(end);
  const dayS     = new Date(navDate); dayS.setHours(0, 0, 0, 0);
  const dayE     = new Date(navDate); dayE.setHours(23, 59, 59, 999);
  const currentDayStillInJob = wasEditing && jobStart <= dayE && jobEnd >= dayS;

  if (currentDayStillInJob) {
    // Stay on the same day — restore exact scroll position
    await renderCalendar();
    const scr = document.getElementById('day-scroll');
    if (scr) scr.scrollTop = savedScrollTop;
  } else {
    // Navigate to the job's start date and scroll to its start hour
    navDate = new Date(jobStart); navDate.setHours(0, 0, 0, 0);
    await renderCalendar();
    const scr = document.getElementById('day-scroll');
    if (scr) scr.scrollTop = Math.max(0, jobStart.getHours() * HOUR_HEIGHT + jobStart.getMinutes() - 120);
  }
}

async function deleteJob() {
  if (!confirm('Delete this print job?')) return;
  await api('DELETE', `/api/jobs/${editJobId}`);
  closeModal('job-modal');
  await renderCalendar();
  // Stay on the same day and restore scroll
  if (view === 'day') {
    const scr = document.getElementById('day-scroll');
    if (scr) scr.scrollTop = savedScrollTop;
  }
}

// =============================================================================
// Printers modal
// =============================================================================
async function openPrintersModal() {
  editPrintId = null;
  await refreshPrinterList();
  resetPrinterForm();

  // Colour swatches
  const swatches = document.getElementById('color-swatches');
  swatches.innerHTML = PRESET_COLORS.map(c =>
    `<div class="color-swatch" style="background:${c}" data-color="${c}" title="${c}"></div>`
  ).join('');
  swatches.querySelectorAll('.color-swatch').forEach(s =>
    s.addEventListener('click', () => { document.getElementById('printer-color').value = s.dataset.color; })
  );

  document.getElementById('printers-modal').classList.remove('hidden');
  document.getElementById('printer-name').focus();
}

async function refreshPrinterList() {
  printers = await api('GET', '/api/printers');
  const list = document.getElementById('printers-list');
  if (!printers.length) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;margin-bottom:4px">No printers yet.</p>';
    return;
  }
  list.innerHTML = printers.map(p => `
    <div class="printer-item">
      <div class="printer-color-dot" style="background:${p.color}"></div>
      <span class="printer-item-name">${escHtml(p.name)}${printerStatusPillHtml(p)}</span>
      <div class="printer-item-actions">
        <button class="btn-icon" onclick="editPrinter(${p.id})" title="Edit">✏️</button>
        <button class="btn-icon danger" onclick="deletePrinter(${p.id})" title="Delete">🗑</button>
      </div>
    </div>`).join('');
}

function setBrand(brand) {
  document.querySelectorAll('#brand-picker .brand-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.brand === brand);
  });
  const isOther   = brand === 'other';
  const isBambu   = brand === 'bambulab';
  document.getElementById('printer-brand-other').classList.toggle('hidden', !isOther);
  document.getElementById('printer-fields-bambulab').classList.toggle('hidden', !isBambu);
}

function resetPrinterForm() {
  editPrintId = null;
  document.getElementById('printer-name').value         = '';
  document.getElementById('printer-color').value        = PRESET_COLORS[printers.length % PRESET_COLORS.length];
  document.getElementById('printer-bambu-serial').value = '';
  document.getElementById('printer-brand-other').value  = '';
  setBrand('bambulab');
  document.getElementById('printer-form-title').textContent = 'Add Printer';
  document.getElementById('btn-save-printer').textContent   = 'Add Printer';
  document.getElementById('btn-cancel-printer').classList.add('hidden');
}

function editPrinter(id) {
  const p = printers.find(pr => pr.id === id);
  if (!p) return;
  editPrintId = id;
  document.getElementById('printer-name').value         = p.name;
  document.getElementById('printer-color').value        = p.color;
  document.getElementById('printer-bambu-serial').value = p.bambu_serial || '';
  const knownBrands = ['bambulab', 'prusa', 'creality', 'klipper', 'octoprint'];
  const brand = p.brand || 'other';
  if (knownBrands.includes(brand)) {
    setBrand(brand);
  } else {
    setBrand('other');
    document.getElementById('printer-brand-other').value = brand;
  }
  document.getElementById('printer-form-title').textContent = 'Edit Printer';
  document.getElementById('btn-save-printer').textContent   = 'Save Changes';
  document.getElementById('btn-cancel-printer').classList.remove('hidden');
  document.getElementById('printer-name').focus();
}

async function savePrinter() {
  const name         = document.getElementById('printer-name').value.trim();
  const color        = document.getElementById('printer-color').value;
  const activeBrand  = document.querySelector('#brand-picker .brand-btn.active')?.dataset.brand || 'other';
  const brand        = activeBrand === 'other'
    ? (document.getElementById('printer-brand-other').value.trim() || 'other')
    : activeBrand;
  const bambu_serial = brand === 'bambulab'
    ? (document.getElementById('printer-bambu-serial').value.trim() || null)
    : null;
  if (!name) return alert('Please enter a printer name.');

  if (editPrintId !== null) await api('PUT', `/api/printers/${editPrintId}`, { name, color, brand, bambu_serial });
  else                      await api('POST', '/api/printers', { name, color, brand, bambu_serial });

  await refreshPrinterList();
  resetPrinterForm();
  renderCalendar();
}

async function deletePrinter(id) {
  const allJobs = await api('GET', '/api/jobs');
  const count   = allJobs.filter(j => j.printerId === id).length;
  const msg     = count
    ? `This printer has ${count} job(s). Deleting it will also remove all its jobs. Continue?`
    : 'Delete this printer?';
  if (!confirm(msg)) return;
  await api('DELETE', `/api/printers/${id}`);
  await refreshPrinterList();
  renderCalendar();
}

// =============================================================================
// Closures modal
// =============================================================================
async function openClosuresModal() {
  editClosureId = null;
  await refreshClosureList();
  resetClosureForm();
  document.getElementById('closures-modal').classList.remove('hidden');
  document.getElementById('closure-start').focus();
}

async function refreshClosureList() {
  closures = await api('GET', '/api/closures');
  closures.sort((a, b) => a.startDate.localeCompare(b.startDate));
  const list = document.getElementById('closures-list');
  if (!closures.length) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;margin-bottom:4px">No closures yet.</p>';
    return;
  }
  list.innerHTML = closures.map(c => {
    const range = c.startDate === c.endDate ? c.startDate : `${c.startDate} – ${c.endDate}`;
    const lbl   = c.label ? ` — ${escHtml(c.label)}` : '';
    return `<div class="printer-item">
      <span style="font-size:16px;flex-shrink:0">🔒</span>
      <span class="printer-item-name">${range}${lbl}</span>
      <div class="printer-item-actions">
        <button class="btn-icon" onclick="editClosure(${c.id})" title="Edit">✏️</button>
        <button class="btn-icon danger" onclick="deleteClosure(${c.id})" title="Delete">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function resetClosureForm() {
  editClosureId = null;
  document.getElementById('closure-start').value = '';
  document.getElementById('closure-end').value   = '';
  document.getElementById('closure-label').value = '';
  document.getElementById('closure-form-title').textContent  = 'Add Closure';
  document.getElementById('btn-save-closure').textContent    = 'Add Closure';
  document.getElementById('btn-cancel-closure').classList.add('hidden');
}

function editClosure(id) {
  const c = closures.find(x => x.id === id);
  if (!c) return;
  editClosureId = id;
  document.getElementById('closure-start').value = c.startDate;
  document.getElementById('closure-end').value   = c.endDate;
  document.getElementById('closure-label').value = c.label ?? '';
  document.getElementById('closure-form-title').textContent  = 'Edit Closure';
  document.getElementById('btn-save-closure').textContent    = 'Save Changes';
  document.getElementById('btn-cancel-closure').classList.remove('hidden');
  document.getElementById('closure-start').focus();
}

async function saveClosure() {
  const startDate = document.getElementById('closure-start').value;
  const endDate   = document.getElementById('closure-end').value   || startDate;
  const label     = document.getElementById('closure-label').value.trim();
  if (!startDate) return alert('Please set a start date.');
  if (endDate < startDate) return alert('End date must be on or after start date.');

  if (editClosureId !== null) await api('PUT', `/api/closures/${editClosureId}`, { startDate, endDate, label });
  else                        await api('POST', '/api/closures', { startDate, endDate, label });

  await refreshClosureList();
  resetClosureForm();
  renderCalendar();
}

async function deleteClosure(id) {
  if (!confirm('Delete this closure?')) return;
  await api('DELETE', `/api/closures/${id}`);
  await refreshClosureList();
  renderCalendar();
}

// =============================================================================
// Settings modal
// =============================================================================
async function openSettingsModal() {
  const themeSetting = await api('GET', '/api/settings/theme');
  const themeSel = document.getElementById('setting-theme');
  if (themeSel) themeSel.value = themeSetting?.value ?? 'system';

  const s = await api('GET', '/api/settings/defaultView');
  const val = s?.value ?? 'day';
  const radio = document.querySelector(`input[name="default-view"][value="${val}"]`);
  if (radio) radio.checked = true;

  // Populate status color pickers from current statusMeta
  ['Planned', 'Printing', 'Post Printing', 'Done'].forEach(status => {
    const inp = document.getElementById('sc-' + status.replace(/\s+/g, '-'));
    if (inp) inp.value = statusMeta[status]?.color ?? '#888888';
  });

  const qae = await api('GET', '/api/settings/queueAutoExpand');
  const cb = document.getElementById('setting-queue-auto-expand');
  if (cb) cb.checked = qae?.value === true;

  // BambuLab connection state
  await renderBambuConnectionState();

  document.getElementById('settings-modal').classList.remove('hidden');
}

async function renderBambuConnectionState() {
  const config = await api('GET', '/api/brands/bambulab/config').catch(() => null);
  const stateLogin     = document.getElementById('bambu-state-login');
  const stateVerify    = document.getElementById('bambu-state-verify');
  const stateConnected = document.getElementById('bambu-state-connected');
  if (!stateLogin) return;

  if (config?.connected) {
    stateLogin.classList.add('hidden');
    stateVerify.classList.add('hidden');
    stateConnected.classList.remove('hidden');
    document.getElementById('bambu-connected-email').textContent = config.email || '';
  } else {
    stateLogin.classList.remove('hidden');
    stateVerify.classList.add('hidden');
    stateConnected.classList.add('hidden');
    if (config?.email) document.getElementById('bambu-email').value = config.email;
    if (config?.region) document.getElementById('bambu-region').value = config.region;
  }
}

async function bambuConnect() {
  const email    = document.getElementById('bambu-email').value.trim();
  const password = document.getElementById('bambu-password').value;
  const region   = document.getElementById('bambu-region').value;
  if (!email || !password) { alert('Enter your BambuLab email and password.'); return; }

  const btn = document.getElementById('btn-bambu-connect');
  btn.disabled = true;
  btn.textContent = 'Connecting…';

  try {
    const res = await api('POST', '/api/brands/bambulab/connect', { email, password, region });
    if (res.status === 'verifyCode') {
      document.getElementById('bambu-state-login').classList.add('hidden');
      document.getElementById('bambu-state-verify').classList.remove('hidden');
      document.getElementById('bambu-code').value = '';
      document.getElementById('bambu-code').focus();
    } else if (res.status === 'ok') {
      await renderBambuConnectionState();
    }
  } catch (e) {
    alert('Connection failed: ' + (e.message || 'Unknown error'));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

async function bambuVerify() {
  const code = document.getElementById('bambu-code').value.trim();
  if (!code) { alert('Enter the verification code from your email.'); return; }

  const btn = document.getElementById('btn-bambu-verify');
  btn.disabled = true;
  btn.textContent = 'Verifying…';

  try {
    const res = await api('POST', '/api/brands/bambulab/verify', { code });
    if (res.status === 'ok') {
      await renderBambuConnectionState();
    }
  } catch (e) {
    alert('Verification failed: ' + (e.message || 'Unknown error'));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify';
  }
}

async function bambuDisconnect() {
  if (!confirm('Disconnect from BambuLab? Live status updates will stop.')) return;
  await api('DELETE', '/api/brands/bambulab/connect');
  await renderBambuConnectionState();
}

async function saveSettings() {
  const themeVal = document.getElementById('setting-theme')?.value ?? 'system';
  await api('PUT', '/api/settings/theme', { value: themeVal });
  applyTheme(themeVal);

  const val = document.querySelector('input[name="default-view"]:checked')?.value ?? 'day';
  await api('PUT', '/api/settings/defaultView', { value: val });

  // Save status colors
  const colors = {};
  ['Planned', 'Printing', 'Post Printing', 'Done'].forEach(status => {
    const inp = document.getElementById('sc-' + status.replace(/\s+/g, '-'));
    if (inp) colors[status] = inp.value;
  });
  await api('PUT', '/api/settings/statusColors', { value: colors });
  await loadStatusColors();

  const cb = document.getElementById('setting-queue-auto-expand');
  await api('PUT', '/api/settings/queueAutoExpand', { value: cb?.checked === true });

  closeModal('settings-modal');
  renderCalendar();
}

// =============================================================================
// Export / Import
// =============================================================================
async function exportData() {
  const res = await fetch('/api/export');
  if (!res.ok) return alert('Export failed.');
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `printfarm-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importData(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return alert('Invalid JSON file.'); }
  if (!data.printers || !data.jobs) return alert('This does not look like a PrintFarm export file.');
  if (!confirm('This will replace ALL existing data. Continue?')) return;
  await api('POST', '/api/import', data);
  alert('Import complete. Reloading...');
  location.reload();
}

// =============================================================================
// Modal helpers
// =============================================================================
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function toDateKey(date) {
  const p = n => String(n).padStart(2,'0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}`;
}

// =============================================================================
// Navigation
// =============================================================================
function navigate(dir) {
  if      (view === 'day')      navDate = addDays(navDate, dir);
  else if (view === 'week')     navDate = addDays(navDate, dir * 7);
  else if (view === 'upcoming') navDate = addDays(navDate, dir * 7);
  else navDate = new Date(navDate.getFullYear(), navDate.getMonth() + dir, 1);
  renderCalendar();
}

// =============================================================================
// Event listeners
// =============================================================================
function setupListeners() {
  // Clicking the date label opens the native date picker
  document.getElementById('date-label').addEventListener('click', () => {
    const inp = document.getElementById('date-jump');
    inp.value = toDateKey(navDate);
    inp.showPicker();
  });
  document.getElementById('date-jump').addEventListener('change', e => {
    if (!e.target.value) return;
    navDate = new Date(e.target.value + 'T00:00:00');
    renderCalendar();
  });

  // Context menu
  document.getElementById('ctx-edit').addEventListener('click', () => {
    if (ctxJobId !== null) openJobModal(ctxJobId);
    hideCtxMenu();
  });
  document.querySelectorAll('.ctx-status-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (ctxJobId !== null) {
        await api('PATCH', `/api/jobs/${ctxJobId}`, { status: btn.dataset.status });
        renderCalendar();
      }
      hideCtxMenu();
    });
  });
  document.getElementById('ctx-duplicate').addEventListener('click', () => {
    if (ctxJobId !== null) duplicateJob(ctxJobId);
    hideCtxMenu();
  });
  document.getElementById('ctx-delete').addEventListener('click', async () => {
    if (ctxJobId !== null && confirm('Delete this print job?')) {
      await api('DELETE', `/api/jobs/${ctxJobId}`);
      renderCalendar();
    }
    hideCtxMenu();
  });
  document.addEventListener('click',       hideCtxMenu);
  document.addEventListener('contextmenu', e => {
    // Hide if right-clicking outside a job element
    if (!e.target.closest('[data-job-id]')) hideCtxMenu();
  });

  // Drag events (document-level so mouse can leave the column)
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup',   onDragEnd);

  document.getElementById('btn-prev').addEventListener('click',  () => navigate(-1));
  document.getElementById('btn-next').addEventListener('click',  () => navigate(+1));
  document.getElementById('btn-today').addEventListener('click', () => {
    navDate = todayMidnight();
    renderCalendar();
    if (view === 'day') setTimeout(scrollToNow, 80);
  });

  ['day','week','month','upcoming'].forEach(v => {
    document.getElementById(`btn-${v}`).addEventListener('click', () => {
      view = v;
      renderCalendar();
      if (v === 'day') setTimeout(scrollToNow, 80);
    });
  });

  // Today panel toggle
  document.getElementById('btn-today-panel').addEventListener('click', () => {
    showTodayPanel = !showTodayPanel;
    document.getElementById('btn-today-panel').classList.toggle('active', showTodayPanel);
    renderTodayPanel();
  });

  document.getElementById('btn-add-job').addEventListener('click', () => {
    if (!printers.length) { openPrintersModal(); return; }
    openJobModal();
  });

  document.getElementById('btn-queue').addEventListener('click', () => {
    showQueuePanel = !showQueuePanel;
    renderQueuePanel();
  });

  document.getElementById('job-queued').addEventListener('change', e => {
    setQueuedMode(e.target.checked);
  });
  document.getElementById('btn-manage-printers').addEventListener('click', openPrintersModal);
  document.getElementById('btn-manage-closures').addEventListener('click', openClosuresModal);
  document.getElementById('btn-save-closure').addEventListener('click', saveClosure);
  document.getElementById('btn-cancel-closure').addEventListener('click', resetClosureForm);
  document.getElementById('btn-printer-status').addEventListener('click', toggleStatusPanel);
  document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-bambu-connect').addEventListener('click', bambuConnect);
  document.getElementById('btn-bambu-verify').addEventListener('click', bambuVerify);
  document.getElementById('btn-bambu-disconnect').addEventListener('click', bambuDisconnect);
  document.getElementById('btn-bambu-cancel-verify').addEventListener('click', renderBambuConnectionState);
  document.getElementById('btn-export').addEventListener('click', exportData);
  document.getElementById('btn-import-trigger').addEventListener('click', () =>
    document.getElementById('import-file').click()
  );
  document.getElementById('import-file').addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  document.getElementById('btn-save-job').addEventListener('click',    saveJob);
  document.getElementById('btn-delete-job').addEventListener('click',  deleteJob);
  document.getElementById('btn-save-printer').addEventListener('click',  savePrinter);
  document.getElementById('btn-cancel-printer').addEventListener('click', resetPrinterForm);
  document.getElementById('brand-picker').addEventListener('click', e => {
    const btn = e.target.closest('.brand-btn');
    if (btn) setBrand(btn.dataset.brand);
  });


  // Duration ↔ end-date toggle
  document.getElementById('toggle-duration').addEventListener('click', () => {
    setEndMode('duration',
      document.getElementById('job-start').value,
      document.getElementById('job-end').value);
  });
  document.getElementById('toggle-enddate').addEventListener('click', () => {
    // Compute end from current start + duration, then switch to end-date mode
    const start = document.getElementById('job-start').value;
    const h = parseInt(document.getElementById('job-duration-h').value) || 0;
    const m = parseInt(document.getElementById('job-duration-m').value) || 0;
    if (start && (h > 0 || m > 0)) {
      document.getElementById('job-end').value =
        toDatetimeLocal(new Date(new Date(start).getTime() + (h * 60 + m) * 60_000));
    }
    setEndMode('enddate', start, document.getElementById('job-end').value);
  });

  // Close buttons
  document.querySelectorAll('[data-close]').forEach(btn =>
    btn.addEventListener('click', () => closeModal(btn.dataset.close))
  );
  // Click overlay to close
  document.querySelectorAll('.modal-overlay').forEach(overlay =>
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay.id); })
  );

  // Escape closes any open modal or context menu
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    hideCtxMenu();
    ['job-modal', 'printers-modal', 'closures-modal', 'settings-modal'].forEach(id => {
      if (!document.getElementById(id).classList.contains('hidden')) closeModal(id);
    });
  });
}

// =============================================================================
// Bootstrap
// =============================================================================
document.addEventListener('DOMContentLoaded', init);
