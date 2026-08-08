// =============================================================================
// PrintFarm Planner — app.js
// =============================================================================

// ---- Constants ----
const DAY_START   = 0;           // first hour rendered in day view
const DAY_END     = 24;          // exclusive
const DAY_MINS    = (DAY_END - DAY_START) * 60;  // 1440

// ---- Day-view vertical scale ----
// The day grid conceptually works in *minutes*: every drag position, job
// start/end and now-line is a minute offset from midnight. Those minute values
// are turned into CSS pixels through PX_PER_MIN. Historically this was a fixed
// 1 px = 1 min (HOUR_HEIGHT = 60). It is now recomputed each renderDay() so the
// full 24h grid grows to fill leftover viewport height on tall screens, while a
// floor (MIN_PX_PER_MIN) keeps short screens scrolling instead of squashing.
const MIN_PX_PER_MIN = 1;        // floor density = 60 px/hour (the historical size)
let   PX_PER_MIN     = MIN_PX_PER_MIN;
let   dayScaleCorrecting = false;  // guards the one-shot first-render scale correction
let   HOUR_HEIGHT    = 60 * PX_PER_MIN;  // px per hour — derived from PX_PER_MIN

// minute <-> pixel conversions. Every day-grid position MUST go through these
// so overlays (job blocks, buffers, now-line, drag targets) stay aligned when
// the grid is scaled.
const minToPx = m  => m  * PX_PER_MIN;
const pxToMin = px => px / PX_PER_MIN;

function setDayScale(pxPerMin) {
  PX_PER_MIN  = pxPerMin;
  HOUR_HEIGHT = 60 * PX_PER_MIN;
}

// Pick a px-per-minute density so the 24h grid fills the scroll viewport when
// there is spare height, but never drops below MIN_PX_PER_MIN (so a short
// window keeps the historical density and scrolls). Measured off the live
// #day-scroll when present (its clientHeight is independent of body content),
// else estimated from #calendar-container minus the sticky header/banner.
function computeDayScale() {
  const scroll = document.getElementById('day-scroll');
  let avail;
  if (scroll) {
    avail = scroll.clientHeight;
  } else {
    const container = document.getElementById('calendar-container');
    avail = (container ? container.clientHeight : 0) - 40; // ~header height
  }
  return Math.max(MIN_PX_PER_MIN, avail / DAY_MINS);
}

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
  'Awaiting':      { color: '#7c3aed' },
  // Pending auto-link: set via "Link when printer starts"; server flips it to
  // 'Printing' when the printer starts. Not a user-selectable status button.
  'Awaiting Printer': { color: '#0891b2' },
  // System-only: server flips a linked job to 'Paused' while the printer
  // is paused; cleared on resume. NOT exposed in any user status picker.
  'Paused':        { color: '#f59e0b' },
};

// ---- API helper ----
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; return; }
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

function isDarkMode() {
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'dark')  return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
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
function printerDetailHtml(s, printer) {
  if (!s) return `<div class="spopup-stage spopup-dim">Waiting for data…</div>`;

  const stageText = s.stage === 'RUNNING' ? `Printing${s.progress > 0 ? ` · ${s.progress}%` : ''}` :
                    s.stage === 'PAUSE'   ? 'Paused' :
                    s.stage === 'FINISH'  ? 'Finished' :
                    s.stage === 'FAILED'  ? 'Error' : 'Idle';
  let html = '';
  if (s.job_name) html += `<div class="spopup-job-name">${escHtml(s.job_name)}</div>`;

  // Linked planned job — shown right below the print file name
  if (printer) {
    const linkedJob = Object.values(jobsCache).find(j => j.linked_printer_id === printer.id);
    if (linkedJob) {
      const label = linkedJob.orderNr ? `#${linkedJob.orderNr} — ${linkedJob.name}` : linkedJob.name;
      html += `<div class="spopup-linked-job" data-job-id="${linkedJob.id}" title="Go to job">🔗 ${escHtml(label)}</div>`;
    }
  }

  html += `<div class="spopup-stage">${stageText}</div>`;
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
    // Compute stable absolute end time from when the update was received
    const endMs   = new Date(s.updated_at).getTime() + s.remaining * 60_000;
    const minsLeft = Math.max(0, Math.round((endMs - Date.now()) / 60_000));
    const h = Math.floor(minsLeft / 60), m = minsLeft % 60;
    const endStr  = new Date(endMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    details.push(`⏱ ${minsLeft > 0 ? (h > 0 ? h + 'h ' : '') + m + 'm left · ' : ''}done ~${endStr}`);
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

  // Determine which printers to show as chips based on topbar mode
  let visiblePrinters;
  if (topbarModeCache === 'active') {
    visiblePrinters = connectedPrinters
      .filter(p => getPrinterLiveStatus(p)?.stage === 'RUNNING')
      .slice(0, topbarLimit);
  } else {
    // pinned mode
    visiblePrinters = connectedPrinters.filter(p => p.pinned);
  }

  const newIds = visiblePrinters.map(p => p.id).join(',');

  if (newIds !== _lastTopbarIds) {
    // Set of displayed printers changed — full rebuild
    _lastTopbarIds = newIds;
    bar.innerHTML = visiblePrinters.map(p => {
      const s     = getPrinterLiveStatus(p);
      const label = printerStatusLabel(s);
      const cls   = s?.stage?.toLowerCase() ?? '';
      return `<div class="schip-wrap" data-pid="${p.id}">
        <div class="schip">
          <span class="schip-dot" style="background:${p.color}"></span>
          <span class="schip-name">${escHtml(p.name)}</span>
          <span class="schip-pill printer-status-pill printer-status-${cls}">${label ? escHtml(label) : ''}</span>
        </div>
        <div class="schip-popup">
          <div class="schip-popup-inner">
            <div class="spopup-name">${escHtml(p.name)}</div>
            ${printerDetailHtml(s, p)}
          </div>
        </div>
      </div>`;
    }).join('');
  } else {
    // Same set — update only pill text/class and popup detail in-place (no flash)
    visiblePrinters.forEach(p => {
      const wrap = bar.querySelector(`.schip-wrap[data-pid="${p.id}"]`);
      if (!wrap) return;
      const s     = getPrinterLiveStatus(p);
      const label = printerStatusLabel(s);
      const cls   = s?.stage?.toLowerCase() ?? '';
      const pill  = wrap.querySelector('.schip-pill');
      if (pill) {
        pill.textContent = label || '';
        pill.className   = `schip-pill printer-status-pill printer-status-${cls}`;
      }
      const popup = wrap.querySelector('.schip-popup');
      if (popup) popup.innerHTML = `<div class="schip-popup-inner"><div class="spopup-name">${escHtml(p.name)}</div>${printerDetailHtml(s, p)}</div>`;
    });
  }

  renderStatusPanel(connectedPrinters);
}

// Close topbar menu when clicking outside
document.addEventListener('click', (e) => {
  const menuWrap = document.getElementById('topbar-menu-wrap');
  if (menuWrap && !menuWrap.contains(e.target)) {
    document.getElementById('topbar-menu')?.classList.remove('open');
    document.getElementById('btn-topbar-menu')?.setAttribute('aria-expanded', 'false');
  }
});

function toggleTopbarMenu() {
  const menu = document.getElementById('topbar-menu');
  const btn  = document.getElementById('btn-topbar-menu');
  const opening = menu.classList.toggle('open');
  btn.setAttribute('aria-expanded', String(opening));
}

// All-printers status panel.
function renderStatusPanel(connectedPrinters) {
  const panel  = document.getElementById('printer-status-panel');
  const btn    = document.getElementById('btn-printer-status');
  const badge  = document.getElementById('printer-status-badge');
  if (!panel || !btn || !badge) return;

  const list = connectedPrinters ?? printers.filter(p => printerStatusKey(p));

  // Hide the button only when there are no connected printers at all
  btn.classList.toggle('hidden', list.length === 0);

  // Badge dot: green if any printer is RUNNING, grey otherwise
  const anyRunning = list.some(p => getPrinterLiveStatus(p)?.stage === 'RUNNING');
  badge.innerHTML  = list.length ? `<span class="status-badge" style="background:${anyRunning ? '#22c55e' : '#94a3b8'}"></span>` : '';

  // Build cards
  panel.innerHTML = list.map(p => {
    const s   = getPrinterLiveStatus(p);
    const label = printerStatusLabel(s);
    const cls   = s?.stage?.toLowerCase() ?? '';
    return `<div class="ps-card">
      <div class="ps-card-header">
        <span class="ps-card-dot" style="background:${p.color}"></span>
        <span class="ps-card-name">${escHtml(p.name)}</span>
        ${label ? `<span class="printer-status-pill printer-status-${cls}">${escHtml(label)}</span>` : ''}
      </div>
      <div class="ps-card-body">${printerDetailHtml(s, p)}</div>
    </div>`;
  }).join('');
}

function toggleStatusPanel() {
  const panel = document.getElementById('printer-status-panel');
  const btn   = document.getElementById('btn-printer-status');
  if (!panel) return;
  const isOpen = !panel.classList.contains('hidden');
  if (isOpen) {
    panel.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  } else {
    renderStatusPanel(); // always rebuild with latest data before showing
    panel.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  }
}

// ---- App state ----
let view           = 'day';
let navDate        = todayMidnight();
let printers       = [];
let editJobId      = null;
let editPrintId    = null;
let savedScrollTop = 0;    // scroll position saved before opening job modal
let ctxJobId       = null; // job ID targeted by the current context menu
let lastConflictIds = new Set(); // conflict IDs from last render
let drag           = null; // active drag state
let showTodayPanel    = false;
let showQueuePanel    = false;
let editingJobStatus  = 'Planned';
let jobsCache       = {};   // id → job, updated on each full DB fetch
let lastDragMoved  = false;
let closures       = [];   // loaded before every render
let editClosureId  = null;
let printerStatus    = {};       // keyed by "brand:serial" — live status from SSE
let topbarLimit      = 3;        // max chips shown; set from /api/config
let topbarModeCache  = 'pinned'; // 'pinned' | 'active'; loaded on init
let _lastTopbarIds   = null;     // comma-joined IDs of last rendered chips; null forces a rebuild
let lastUpcomingHtml = null;     // last markup rendered by renderUpcoming; lets a no-op SSE re-render skip the DOM rebuild
let lastWeekHtml     = null;     // ditto for renderWeek — skip no-op SSE rebuilds, preserve .week-view scroll
let lastMonthHtml    = null;     // ditto for renderMonth — skip no-op SSE rebuilds, preserve .month-view scroll
let bambuAccountEmail = null;    // set when BambuLab account is connected
let pushSubscribed = false;

let mobilePrinterIdx = 0;       // currently selected printer index in mobile day view
let isTouchDevice = false;      // set on first touch event
let pendingScrollToNow = false; // when true, the next renderDay centres on now

let sseSource = null;            // EventSource for live printer status
let sseRetryTimer = null;        // setTimeout handle for SSE reconnect

// =============================================================================
// Init
// =============================================================================
function applyTheme(mode) {
  if (mode === 'dark')       document.documentElement.setAttribute('data-theme', 'dark');
  else if (mode === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else                       document.documentElement.removeAttribute('data-theme');
}

// =============================================================================
// SSE connection with auto-reconnect
// =============================================================================
function connectSSE() {
  if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
  if (sseSource) { sseSource.close(); sseSource = null; }

  sseSource = new EventSource('/api/printers/status/stream');

  sseSource.onmessage = (e) => {
    try {
      const updates = JSON.parse(e.data);
      if (updates.jobsUpdated) { renderCalendar().then(refreshStatusOverviewIfOpen); return; }
      // Server pushes an explicit stageChanged event on every real
      // printer stage transition — always re-render on it. Partial frames
      // from Bambu carry over the old stage (bambu.js:128-160), so the
      // client-side diff is unreliable.
      if (updates.stageChanged) { renderCalendar().then(refreshStatusOverviewIfOpen); return; }
      // Fallback: any status frame that carries a `stage` field gets a
      // re-render. renderDay() is idempotent re. scroll position, so this
      // is cheap (stage only ships on transitions from Bambu).
      let stagePresent = false;
      for (const [, next] of Object.entries(updates)) {
        if (next && typeof next === 'object' && next.stage !== undefined) stagePresent = true;
      }
      Object.assign(printerStatus, updates);
      renderTopbarStatus();
      if (stagePresent) renderCalendar().then(refreshStatusOverviewIfOpen);
    } catch (_) {}
  };

  sseSource.onerror = () => {
    // Close and schedule reconnect — browser SSE auto-reconnect can stall after
    // the tab returns from background, so we manage reconnection ourselves.
    if (sseSource) { sseSource.close(); sseSource = null; }
    if (!sseRetryTimer) {
      sseRetryTimer = setTimeout(() => { sseRetryTimer = null; connectSSE(); }, 5000);
    }
  };
}

// Re-fetch all data and reconnect SSE when the tab becomes visible again.
// Handles the case where the browser put the SSE stream to sleep in the background.
async function onPageVisible() {
  printers = await api('GET', '/api/printers').catch(() => printers);
  await renderCalendar();
  renderTopbarStatus();
  // Reset the cached per-printer status map so the first SSE frame after
  // reconnect seeds fresh — prevents stale PAUSE stages from masking a
  // RUNNING transition that happened while the tab was backgrounded.
  printerStatus = {};
  if (!sseSource || sseSource.readyState === EventSource.CLOSED) connectSSE();
}

async function init() {
  // Load server-side config (env-driven)
  const config = await api('GET', '/api/config').catch(() => null);
  if (config?.topbarPrinterLimit > 0) topbarLimit = config.topbarPrinterLimit;
  if (config?.version) {
    const el = document.getElementById('app-version');
    if (el) el.textContent = `v${config.version}`;
  }
  // Optional deploy line — only rendered if release.env was present AND
  // complete on the server. If config.deploy is null we leave the element
  // empty (and CSS hides it via :empty).
  if (config?.deploy) {
    const d = config.deploy;
    const depEl = document.getElementById('app-deploy');
    if (depEl) depEl.textContent = `${d.branch}.${d.sha} (${d.timestamp})`;
  }

  // Register service worker for push notifications
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // The SW pings open tabs on every push so we can play a bell, and on
    // notification click so we can deep-link to the relevant job/printer.
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'play-sound') playNotificationBell();
      if (e.data?.type === 'navigate')   handleDeepLink(e.data.url);
    });
  }

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

  // Load topbar display mode
  const tmSetting = await api('GET', '/api/settings/topbarMode');
  if (tmSetting?.value) topbarModeCache = tmSetting.value;

  // Connect to live Bambu printer status stream
  connectSSE();

  // Restore view + navDate from the URL hash on load. Covers:
  //   - refresh while on a non-today day
  //   - sharing a link
  //   - browser back/forward (the popstate listener below handles subsequent)
  //   - notification deep links (#job/N, #printer/N)
  const restored = location.hash ? handleDeepLink(location.hash) : false;

  if (!restored) {
    if (view === 'day') pendingScrollToNow = true;
    renderCalendar();
    // Write a canonical hash on first load so a refresh preserves state.
    syncUrlToState({ replace: true });
  }
  renderTopbarStatus();
  setupListeners();
  setInterval(() => { updateNowLine(); renderTopbarStatus(); updateTodayButton(); }, 60_000);
  if (printers.length === 0) openPrintersModal();
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

function getStartVal() {
  const d = document.getElementById('job-start-date').value;
  const t = document.getElementById('job-start-time').value;
  return d && t ? `${d}T${t}` : (d ? `${d}T00:00` : '');
}

function getEndVal() {
  const d = document.getElementById('job-end-date').value;
  const t = document.getElementById('job-end-time').value;
  return d && t ? `${d}T${t}` : (d ? `${d}T00:00` : '');
}

function setStartVal(val) {
  if (val && val.includes('T')) {
    const [d, t] = val.split('T');
    document.getElementById('job-start-date').value = d;
    document.getElementById('job-start-time').value = t.slice(0, 5);
  } else {
    document.getElementById('job-start-date').value = val ? val.split('T')[0] : '';
    document.getElementById('job-start-time').value = '';
  }
}

function setEndVal(val) {
  if (val && val.includes('T')) {
    const [d, t] = val.split('T');
    document.getElementById('job-end-date').value = d;
    document.getElementById('job-end-time').value = t.slice(0, 5);
  } else {
    document.getElementById('job-end-date').value = val ? val.split('T')[0] : '';
    document.getElementById('job-end-time').value = '';
  }
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
    'Awaiting':      { color: colors['Awaiting']      ?? '#7c3aed' },
    // Pending auto-link (see top of file). Not exposed in settings pickers.
    'Awaiting Printer': { color: colors['Awaiting Printer'] ?? '#0891b2' },
    // System-only (see top of file). Not exposed in settings pickers.
    'Paused':        { color: colors['Paused']        ?? '#f59e0b' },
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

function formatBedType(raw) {
  if (!raw) return '';
  const map = {
    'textured_plate': 'Textured',
    'cool_plate': 'Cool Plate',
    'hot_plate': 'Smooth (High Temp)',
    'eng_plate': 'Engineering',
    'smooth_plate': 'Smooth',
  };
  return map[raw] || raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function renderColorSwatches(colorsStr) {
  if (!colorsStr) return '';
  try {
    const arr = JSON.parse(colorsStr);
    if (!Array.isArray(arr) || !arr.length) return '';
    // Sort: L (left) first, R (right) second, no extruder last
    arr.sort((a, b) => (a.extruder === 'L' ? 0 : a.extruder === 'R' ? 1 : 2) - (b.extruder === 'L' ? 0 : b.extruder === 'R' ? 1 : 2));
    return `<span class="color-swatches">${arr.map(c => {
      const extLabel = c.extruder ? `<span class="color-ext">${c.extruder}</span>` : '';
      const title = `${c.name || ''}${c.brand ? ' (' + c.brand + ')' : ''}${c.extruder ? ' [Extruder ' + c.extruder + ']' : ''}`;
      return `<span class="color-dot-wrap">${extLabel}<span class="color-dot" style="background:${escHtml(c.color)}" title="${escHtml(title)}"></span></span>`;
    }).join('')}</span>`;
  } catch { return escHtml(colorsStr); }
}

// Play a short two-tone chime via WebAudio. Called when the service worker
// notifies us of an incoming push so notifications are audible even when
// the OS mutes web-push sounds. Only works if the user has interacted with
// the page since load (AudioContext autoplay restriction).
function playNotificationBell() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!window._audioCtx) window._audioCtx = new Ctx();
    const ctx = window._audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [880, 1175].forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain).connect(ctx.destination);
      const t0 = now + i * 0.12;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.6);
      osc.start(t0);
      osc.stop(t0 + 0.6);
    });
  } catch { /* ignore */ }
}

// =============================================================================
// Filament-manager catalog lookup
// =============================================================================
// Mirrors filament-match.js (server-side). When the filament-manager sibling
// app is reachable we fetch its catalog and translate each printed hex into
// the matching brand-named filament — replacing the generic ntc name. See
// memory: mobile_safari_rules.md for the cross-app discovery / shared-auth
// pattern these helpers reuse.

let _filamentCatalogCache = null;
let _filamentCatalogTime  = 0;
const FILAMENT_CATALOG_TTL_MS = 5 * 60 * 1000;

async function fetchFilamentCatalog() {
  const now = Date.now();
  if (_filamentCatalogCache && (now - _filamentCatalogTime) < FILAMENT_CATALOG_TTL_MS) {
    return _filamentCatalogCache;
  }
  try {
    // Use the server-side proxy which fetches from the filament-manager via
    // shared-auth. Direct browser-to-filament-manager requests fail because
    // of cross-origin restrictions (no CORS, auth cookies don't travel).
    const list = await api('GET', '/api/filament-catalog');
    _filamentCatalogCache = Array.isArray(list) ? list : [];
    _filamentCatalogTime  = now;
    return _filamentCatalogCache;
  } catch { return []; }
}

function _normHex(s) {
  if (!s) return null;
  let h = String(s).trim().toLowerCase();
  if (!h.startsWith('#')) h = '#' + h;
  if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  return /^#[0-9a-f]{6}$/.test(h) ? h : null;
}
function _normKey(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-]+/g, '');
}

// Same logic as filament-match.js#matchFilament. Tie-break:
//   1. (brand+type) discriminator count, higher wins
//   2. inStock wins
//   3. lowest id wins
function matchFilamentInCatalog(query, catalog) {
  const target = _normHex(query?.color);
  if (!target || !Array.isArray(catalog)) return null;
  const candidates = catalog.filter(f => _normHex(f.colorHex) === target);
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const qBrand = _normKey(query.brand);
  const qType  = _normKey(query.type);
  function score(f) {
    const fBrand = _normKey(f.brand);
    const fType  = _normKey(f.type);
    const bm = qBrand && fBrand && fBrand === qBrand;
    const tm = qType  && fType  && fType  === qType;
    return [(bm ? 1 : 0) + (tm ? 1 : 0), f.inStock ? 1 : 0, -f.id];
  }
  let best = candidates[0], bs = score(best);
  for (let i = 1; i < candidates.length; i++) {
    const s = score(candidates[i]);
    if (s[0] > bs[0] ||
        (s[0] === bs[0] && s[1] > bs[1]) ||
        (s[0] === bs[0] && s[1] === bs[1] && s[2] > bs[2])) {
      best = candidates[i]; bs = s;
    }
  }
  return best;
}

function parseColorsField(val) {
  if (!val) return [];
  try { const arr = JSON.parse(val); if (Array.isArray(arr)) return arr; } catch {}
  // Legacy: plain text like "White PLA + Black PETG" → one entry per segment
  if (val.trim()) return val.split(/[+,;]/).map(s => ({ color: '#888888', name: s.trim(), brand: '' })).filter(c => c.name);
  return [];
}

function renderColorEditor(colors) {
  const sorted = [...colors].sort((a, b) => (a.extruder === 'L' ? 0 : a.extruder === 'R' ? 1 : 2) - (b.extruder === 'L' ? 0 : b.extruder === 'R' ? 1 : 2));
  const rows = sorted.map((c, i) => renderColorEditorRow(c, i)).join('');
  return `<div id="job-color-rows">${rows}</div>
    <button type="button" class="btn btn-sm" style="margin-top:4px" onclick="addJobColorRow()">+ Add Color</button>`;
}

function renderColorEditorRow(c, i) {
  const name = c.name || (typeof ntc !== 'undefined' && c.color ? (ntc.name(c.color)?.[1] || '') : '');
  const extBadge = c.extruder ? `<span class="color-ext-badge" style="flex-shrink:0">${escHtml(c.extruder)}</span>` : '';
  return `<div class="color-edit-row" data-cidx="${i}">
    ${extBadge}
    <input type="color" value="${c.color || '#888888'}" class="color-picker" data-cf="color" onchange="updateJobColorName(this)">
    <input type="text" value="${escHtml(name)}" placeholder="Name" class="color-name-input" data-cf="name">
    <input type="text" value="${escHtml(c.brand || '')}" placeholder="Brand" class="color-brand-input" data-cf="brand">
    <input type="hidden" value="${escHtml(c.extruder || '')}" data-cf="extruder">
    <button type="button" class="btn-icon" onclick="this.closest('.color-edit-row').remove()" title="Remove">&times;</button>
  </div>`;
}

function addJobColorRow() {
  const list = document.getElementById('job-color-rows');
  const i = list.children.length;
  const div = document.createElement('div');
  div.className = 'color-edit-row';
  div.dataset.cidx = i;
  div.innerHTML = `<input type="color" value="#888888" class="color-picker" data-cf="color" onchange="updateJobColorName(this)">
    <input type="text" value="" placeholder="Name" class="color-name-input" data-cf="name">
    <input type="text" value="" placeholder="Brand" class="color-brand-input" data-cf="brand">
    <button type="button" class="btn-icon" onclick="this.closest('.color-edit-row').remove()" title="Remove">&times;</button>`;
  list.appendChild(div);
}

function updateJobColorName(colorInput) {
  const row = colorInput.closest('.color-edit-row');
  const nameInput = row.querySelector('[data-cf="name"]');
  if (!nameInput.value.trim() && typeof ntc !== 'undefined') {
    nameInput.value = ntc.name(colorInput.value)?.[1] || '';
  }
}

function collectJobColors() {
  const rows = document.querySelectorAll('#job-color-rows .color-edit-row');
  if (!rows.length) return '';
  const arr = Array.from(rows).map(row => {
    const ext = row.querySelector('[data-cf="extruder"]')?.value || null;
    return {
      color: row.querySelector('[data-cf="color"]').value,
      name: row.querySelector('[data-cf="name"]').value.trim() || (typeof ntc !== 'undefined' ? ntc.name(row.querySelector('[data-cf="color"]').value)?.[1] || '' : ''),
      brand: row.querySelector('[data-cf="brand"]').value.trim(),
      ...(ext ? { extruder: ext } : {}),
    };
  });
  return JSON.stringify(arr);
}

function renderColorDetail(colorsStr) {
  if (!colorsStr) return '';
  try {
    const arr = JSON.parse(colorsStr);
    if (!Array.isArray(arr) || !arr.length) return '';
    arr.sort((a, b) => (a.extruder === 'L' ? 0 : a.extruder === 'R' ? 1 : 2) - (b.extruder === 'L' ? 0 : b.extruder === 'R' ? 1 : 2));
    return `<div class="color-detail">${arr.map(c =>
      `<span class="color-chip"><span class="color-dot" style="background:${escHtml(c.color)}"></span>${escHtml(c.name || '')}${c.extruder ? ` <span class="color-ext-badge">${c.extruder}</span>` : ''}${c.brand ? ` <span style="opacity:.6">(${escHtml(c.brand)})</span>` : ''}</span>`
    ).join('')}</div>`;
  } catch { return escHtml(colorsStr); }
}

// =============================================================================
// Conflict detection
// =============================================================================
function detectConflicts(jobs, printerMap) {
  const ids = new Set();

  // Group by printer (jobs on different printers never conflict) and precompute
  // each job's BUFFER-INCLUSIVE interval once. Cool-down is attributed to the
  // finishing job: each job's trailing buffer uses its OWN snapshotted
  // cool_down_mins (fall back printer scalar → 15); warm-up is per-job with the
  // same fallback chain (→ 0). One Date parse per job instead of one per pair.
  const byPrinter = new Map();
  for (const job of jobs) {
    const p  = printerMap?.[job.printerId];
    const cd = job.cool_down_mins ?? p?.cool_down_mins ?? 15;
    const wu = job.warm_up_mins   ?? p?.warm_up_mins   ?? 0;
    const s  = new Date(job.start).getTime() - wu * 60_000;
    const e  = new Date(job.end).getTime()   + cd * 60_000;
    let arr = byPrinter.get(job.printerId);
    if (!arr) { arr = []; byPrinter.set(job.printerId, arr); }
    arr.push({ id: job.id, s, e });
  }

  // Per-printer sweep line: sort by buffered start, keep the set of still-open
  // intervals. Two intervals overlap iff aStart < bEnd && aEnd > bStart; for any
  // interval still "active" when `cur` opens (active.e > cur.s), that condition
  // holds both ways, so `cur` conflicts with every active interval. Same result
  // set as the old O(n²) pair scan, but O(n log n) for the realistic case of a
  // long, mostly-disjoint job history (the accumulation that made the day view
  // block the main thread → Chrome "Page Unresponsive").
  for (const arr of byPrinter.values()) {
    arr.sort((a, b) => (a.s - b.s) || (a.e - b.e));
    let active = [];
    for (const cur of arr) {
      if (active.length) active = active.filter(a => a.e > cur.s);
      if (active.length) {
        ids.add(cur.id);
        for (const a of active) ids.add(a.id);
      }
      active.push(cur);
    }
  }

  return ids;
}

// Column-packing for time-overlapping jobs within a single printer column.
// Classic interval-graph packing (same approach Google/Apple Calendar use):
// jobs that transitively overlap in time form a cluster; each job gets a
// sub-column index `col` and the cluster's total column count `nCols`, so the
// renderer can size it to width = colWidth/nCols at left = col*(colWidth/nCols).
// Overlap is decided on each job's BUFFER-INCLUSIVE interval
// [start - warmUp, end + coolDown] — two jobs whose print windows don't touch
// still share a column (render side-by-side) when job A's cool-down overlaps
// job B's warm-up. The caller passes those already-buffered intervals, matching
// the ⚠ conflict notion in detectConflicts (if ⚠ fires, they render side-by-side).
//
// Input:  intervals = [{ id, start, end }] numeric ms/min, buffers already applied.
// Output: Map<id, { col, nCols }>. Non-overlapping (lone) jobs get nCols = 1.
function computeColumnLayout(intervals) {
  const layout = new Map();
  const sorted = [...intervals].sort((a, b) => (a.start - b.start) || (a.end - b.end));

  let cluster   = [];          // jobs in the current overlap cluster
  let columns   = [];          // columns[k] = end time of last job placed in column k
  let clusterEnd = -Infinity;  // max end across the current cluster

  const flush = () => {
    const nCols = columns.length;
    for (const ev of cluster) layout.set(ev.id, { col: ev._col, nCols });
    cluster = [];
    columns = [];
  };

  for (const ev of sorted) {
    // A gap (this job starts at/after every current-cluster job has ended)
    // closes the cluster: the connected component of the overlap graph ends.
    if (cluster.length && ev.start >= clusterEnd) flush();

    // Place in the first column whose last job has already ended; else new column.
    let col = -1;
    for (let k = 0; k < columns.length; k++) {
      if (columns[k] <= ev.start) { col = k; break; }
    }
    if (col === -1) { col = columns.length; columns.push(ev.end); }
    else            { columns[col] = ev.end; }

    ev._col = col;
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.end);
  }
  if (cluster.length) flush();

  return layout;
}

// =============================================================================
// Conflict resolution
// =============================================================================
async function resolveConflictMoveAfter(jobId) {
  const job = jobsCache[jobId];
  if (!job) return;
  const printer = printers.find(p => p.id === job.printerId);
  // Warm-up and cool-down are both per-job (snapshotted); fall back to the
  // printer scalar, then the code default.
  const warmUp = job.warm_up_mins ?? printer?.warm_up_mins ?? 5;
  const myCoolDown = job.cool_down_mins ?? printer?.cool_down_mins ?? 15;

  // Find the conflicting job(s) on the same printer that overlap
  const allJobs = Object.values(jobsCache).filter(j =>
    j.id !== jobId && j.printerId === job.printerId && !j.queued
  );
  // Find the latest-ending conflicting job. Its OWN cool-down owns the gap the
  // moved job must clear, matching the per-job server schedule.
  let latestEnd = 0;
  let latestCoolDown = myCoolDown;
  const jobStart = new Date(job.start).getTime() - warmUp * 60000;
  const jobEnd = new Date(job.end).getTime() + myCoolDown * 60000;
  for (const j of allJobs) {
    const jCoolDown = j.cool_down_mins ?? printer?.cool_down_mins ?? 15;
    const jWarmUp = j.warm_up_mins ?? printer?.warm_up_mins ?? 5;
    const jStart = new Date(j.start).getTime() - jWarmUp * 60000;
    const jEnd = new Date(j.end).getTime() + jCoolDown * 60000;
    if (jStart < jobEnd && jEnd > jobStart) {
      const realEnd = new Date(j.end).getTime();
      if (realEnd > latestEnd) { latestEnd = realEnd; latestCoolDown = jCoolDown; }
    }
  }
  if (!latestEnd) return;

  // New start = latest conflicting end + that job's cool-down + warm-up. Route
  // the move through the push-back pipeline so it runs the SAME fit -> confirm ->
  // cascade: the clicked job lands after the conflict and every job after it is
  // reshoved to keep the schedule packed (with a confirm dialog if a reshuffle
  // is needed). pushBackJob handles render + notices.
  const newStart = new Date(latestEnd + (latestCoolDown + warmUp) * 60000);
  await pushBackJob(jobId, newStart.toISOString());
}

async function resolveConflictNextDay(jobId) {
  const job = jobsCache[jobId];
  if (!job) return;
  const start = new Date(job.start);
  const end = new Date(job.end);
  const durationMs = end.getTime() - start.getTime();
  // Move to same time next day
  start.setDate(start.getDate() + 1);
  const newEnd = new Date(start.getTime() + durationMs);
  await api('PATCH', `/api/jobs/${jobId}`, { start: start.toISOString(), end: newEnd.toISOString() });
  await renderCalendar();
}

async function resolveConflictMovePrinter(jobId) {
  const job = jobsCache[jobId];
  if (!job) return;
  // Show quick picker with available printers (excluding current)
  const otherPrinters = printers.filter(p => p.id !== job.printerId);
  if (!otherPrinters.length) { alert('No other printers available'); return; }

  const names = otherPrinters.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
  const choice = prompt(`Move to which printer?\n\n${names}`, '1');
  if (!choice) return;
  const idx = parseInt(choice) - 1;
  if (idx < 0 || idx >= otherPrinters.length) return;

  await api('PATCH', `/api/jobs/${jobId}`, { printerId: otherPrinters[idx].id });
  await renderCalendar();
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

  // Live-refresh the "Job Status" menu badge (post printing + paused count).
  updateStatusOverviewBadge();

  // Clear mobile printer switcher when not in day view
  if (view !== 'day') document.getElementById('mobile-printer-switcher').innerHTML = '';

  // Day-view scroll preservation lives entirely inside renderDay() — it
  // captures prevScrollTop right before the innerHTML swap and restores it
  // (unless pendingScrollToNow is set, in which case scrollToNow wins via
  // a deferred rAF). An outer capture/restore here used to fight that
  // mechanism: a stale pre-await savedScroll would clobber whatever
  // renderDay just did, causing scroll jitter during SSE bursts. See #140.
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
  updateTodayButton();
}

// Is "today" currently visible in the active view?
function isTodayInView() {
  const today = todayMidnight();
  if (view === 'day')   return sameDay(navDate, today);
  if (view === 'week')  { const ws = weekStart(navDate); return today >= ws && today < addDays(ws, 7); }
  if (view === 'month') return navDate.getFullYear() === today.getFullYear() && navDate.getMonth() === today.getMonth();
  return true; // upcoming is always anchored at today
}

// Reflect today-in-view on the Today button: when today is already shown the
// button reads "active" and is disabled (nothing to jump to); otherwise it's the
// default clickable state that jumps to today. Re-evaluated on every render AND
// on the 1-min tick, so leaving the view open across midnight re-enables it.
function updateTodayButton() {
  const btn = document.getElementById('btn-today');
  if (!btn) return;
  const showingToday = isTodayInView();
  btn.classList.toggle('is-today', showingToday);
  btn.disabled = showingToday;
  btn.title = showingToday ? 'Today is shown' : 'Jump to today';
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

  // Right-click a queue item → scheduling menu, but ONLY when it is bound to a
  // printer (data-printer set). An unassigned queue job has no lane to schedule
  // onto, so it gets no menu — set a printer (Edit) or drag it onto one instead.
  panel.querySelectorAll('.queue-item').forEach(item =>
    item.addEventListener('contextmenu', e => {
      // data-printer is '' for an unassigned job, the printer id otherwise. Gate on
      // presence (not truthiness) so a 0 id could never be mis-read as unassigned.
      if (!item.dataset.printer) return; // unassigned → no menu (native menu shows)
      showQueueCtxMenu(e, parseInt(item.dataset.id));
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
// Rebuild jobsCache from a full /api/jobs fetch. Unlike a merge, this DROPS
// entries for jobs deleted since the last fetch, so the status-overview badge
// and dialog never over-count or show phantom rows. Every full-DB render path
// (day/week/month/upcoming + openStatusOverview) funnels through here, and the
// live SSE path re-renders via renderCalendar() -> these same renders, so it
// stays correct too.
function rebuildJobsCache(allJobs) {
  jobsCache = {};
  allJobs.forEach(j => { jobsCache[j.id] = j; });
}

async function renderDay() {
  const container = document.getElementById('calendar-container');
  if (!printers.length) { renderEmpty(container); return; }

  const dayS = new Date(navDate); dayS.setHours(0,0,0,0);
  const allJobs      = await api('GET', '/api/jobs');
  const scheduledJobs = allJobs.filter(j => !j.queued);
  const jobs          = scheduledJobs.filter(j => overlapsDay(j, navDate));

  // Rebuild jobs cache fresh (prunes deleted jobs — see rebuildJobsCache)
  rebuildJobsCache(allJobs);

  // Detect conflicts across scheduled jobs only (buffer times included)
  const printerMap  = Object.fromEntries(printers.map(p => [p.id, p]));
  lastConflictIds = detectConflicts(scheduledJobs, printerMap);
  const conflictIds = lastConflictIds;

  const dayClosure = closureForDay(navDate);

  // Filter to favourite printers for day view
  const visiblePrinters = printers.filter(p => p.favourite);

  if (!visiblePrinters.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div style="font-size:52px">📅</div>
        <h2>No printers shown in day view</h2>
        <p>Open Printer Settings and check <strong>Show in day view</strong> for the printers you want to schedule here.</p>
        <button class="btn btn-primary" onclick="openPrintersModal()">Open Printer Settings</button>
      </div>`;
    return;
  }

  // ---- Build HTML ----
  let h = '<div class="day-view">';

  // Header (printer columns)
  h += '<div class="day-view-header">';
  h += '<div class="day-time-gutter-header"></div>';
  visiblePrinters.forEach(p => {
    h += `<div class="day-printer-header" style="color:${p.color}">${escHtml(p.name)}</div>`;
  });
  h += '<button class="day-settings-btn" onclick="openPrintersModal()" title="Printer settings (choose favourites for day view)">⚙</button>';
  h += '</div>';

  // Closure banner
  if (dayClosure) {
    const lbl = escHtml(dayClosure.label || 'Closed');
    h += `<div class="day-closed-banner">🔒 ${lbl} — no jobs can be scheduled on this day</div>`;
  }

  // Scale the grid to fill leftover viewport height (see computeDayScale).
  setDayScale(computeDayScale());

  // Scrollable body
  h += `<div class="day-view-scroll" id="day-scroll">`;
  h += `<div class="day-view-body" style="height:${minToPx(DAY_MINS)}px">`;

  // Time gutter
  h += '<div class="day-time-gutter">';
  for (let hr = DAY_START; hr < DAY_END; hr++) {
    const top = (hr - DAY_START) * HOUR_HEIGHT;
    h += `<div class="time-label" style="top:${top}px">${String(hr).padStart(2,'0')}:00</div>`;
  }
  h += '</div>';

  // One column per printer
  visiblePrinters.forEach(p => {
    h += `<div class="day-printer-col${dayClosure ? ' day-col-closed' : ''}" data-printer-id="${p.id}">`;
    if (dayClosure) h += '<div class="day-closed-overlay"></div>';

    // Hour + half-hour grid lines
    for (let hr = DAY_START; hr < DAY_END; hr++) {
      const top = (hr - DAY_START) * HOUR_HEIGHT;
      h += `<div class="hour-line"      style="top:${top}px"></div>`;
      h += `<div class="half-hour-line" style="top:${top + HOUR_HEIGHT/2}px"></div>`;
    }

    // Job blocks
    const colJobs = jobs.filter(j => j.printerId === p.id);
    // Side-by-side layout: split the column across overlapping jobs so none is
    // hidden behind another. Overlap uses each job's BUFFER-INCLUSIVE interval
    // [start - warmUp, end + coolDown] (per-job snapshots, printer fallback) so
    // a cool-down/warm-up clash splits them too — matching the ⚠ conflict notion.
    const colLayout = computeColumnLayout(colJobs.map(j => {
      const wu = j.warm_up_mins  ?? p.warm_up_mins  ?? 0;
      const cd = j.cool_down_mins ?? p.cool_down_mins ?? 15;
      return {
        id:    j.id,
        start: new Date(j.start).getTime() - wu * 60_000,
        end:   new Date(j.end).getTime()   + cd * 60_000,
      };
    }));
    colJobs.forEach(job => {
      const start = new Date(job.start);
      const end   = new Date(job.end);
      // Clamp to day boundaries using ms arithmetic (avoids midnight roll-over bugs)
      const startMins = (start.getTime() - dayS.getTime()) / 60_000;
      const endMins   = (end.getTime()   - dayS.getTime()) / 60_000;
      const topPx  = Math.max(0, minToPx(startMins));
      const htPx   = Math.max(minToPx(Math.min(endMins, DAY_MINS)) - topPx, 18); // 18px visual floor

      // Horizontal placement: lone job (nCols 1) keeps the CSS full-column
      // width; overlapping jobs each take colWidth/nCols at left = col*width.
      const lay = colLayout.get(job.id) ?? { col: 0, nCols: 1 };
      const splitStyle = lay.nCols > 1
        ? `left:${(lay.col * 100 / lay.nCols).toFixed(4)}%; width:${(100 / lay.nCols).toFixed(4)}%; right:auto;`
        : '';

      const status     = job.status ?? 'Planned';
      const isConflict = conflictIds.has(job.id);
      const conflictCls  = isConflict ? ' job-conflict' : '';
      const conflictIcon = isConflict ? '<span class="job-conflict-icon" title="Scheduling conflict">⚠</span>' : '';
      // Highlight the linked job if its printer is currently paused.
      const isPaused   = !!job.linked_printer_id && getPrinterLiveStatus(p)?.stage === 'PAUSE';
      const pausedCls  = isPaused ? ' job-paused' : '';
      const pausedIcon = isPaused ? '<span class="job-paused-icon" title="Printer paused">⏸</span>' : '';
      const lockIcon   = job.locked ? '<span class="job-lock-icon" title="Locked — immovable">🔒</span>' : '';

      const bgAlpha  = isDarkMode() ? 0.5 : 0.15;
      // Buffer blocks (warm-up / cool-down) render as a WASHED-OUT tint of this
      // job's own colour (clearly lighter than the solid job block above) plus a
      // dashed left border in the full colour — so a buffer visually belongs to
      // its job even when overlapping jobs sit side-by-side in the column.
      const bufBg    = hexRgba(p.color, isDarkMode() ? 0.22 : 0.07);
      const bufStyle = `background:${bufBg};border-left-color:${p.color};`;
      // Warm-up buffer renders from the job's own snapshotted warm_up_mins
      // (per-job); fall back to the printer scalar, then 0, defensively.
      const warmUp   = job.warm_up_mins ?? p.warm_up_mins ?? 0;
      // Cool-down buffer is attributed to the FINISHING job, so it renders from
      // that job's own snapshotted cool_down_mins (matching the authoritative
      // server schedule); fall back to the printer scalar, then 15, defensively.
      const coolDown = job.cool_down_mins ?? p.cool_down_mins ?? 15;

      // Warm-up buffer block (before job)
      if (warmUp > 0) {
        const bTop = Math.max(0, topPx - minToPx(warmUp));
        const bHt  = topPx - bTop;
        if (bHt > 0) {
          h += `<div class="buffer-block" data-job-id="${job.id}" data-buffer-type="warmup" style="top:${bTop}px;height:${bHt}px;${splitStyle}${bufStyle}">${bHt >= 10 ? '<span class="buffer-label">Warm-up</span>' : ''}</div>`;
        }
      }

      h += `<div class="job-block${conflictCls}${pausedCls}" data-job-id="${job.id}"
              data-job-start="${job.start}" data-job-end="${job.end}"
              style="top:${topPx}px; height:${htPx}px; ${splitStyle}
                     background:${hexRgba(p.color, bgAlpha)};
                     border-left-color:${isConflict ? '#e53e3e' : isPaused ? '#f59e0b' : p.color};
                     color:var(--text)">
              <div style="display:flex;align-items:center;gap:4px;overflow:hidden">
                ${conflictIcon}
                ${pausedIcon}
                ${lockIcon}
                <span class="job-block-name" style="flex-shrink:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${job.orderNr ? `#${escHtml(job.orderNr)} — ` : ''}${escHtml(job.name)}</span>
                ${job.colors ? renderColorSwatches(job.colors) : ''}
                ${job.linked_printer_id ? '<span title="Linked to printer">🔗</span>' : ''}
                <span class="job-status-badge" style="flex-shrink:0;${statusBadgeStyle(status)}">${escHtml(status)}</span>
              </div>`;
      if (htPx >= 40 && job.customerName) h += `<span class="job-block-customer">${escHtml(job.customerName)}</span>`;
      if (htPx >= 40 && job.project) h += `<span class="job-block-project">${escHtml(job.project)}</span>`;
      if (htPx >= 55 && job.bedType) h += `<span class="job-block-bedtype">${formatBedType(job.bedType)}</span>`;
      if (htPx >= 80 && job.thumbFile) h += `<img src="/api/uploads/${escHtml(job.thumbFile)}" class="job-block-thumb" alt="">`;
      if (endMins <= DAY_MINS) h += '<div class="job-resize-handle"></div>';
      h += '</div>';

      // Cool-down buffer block (after job)
      if (coolDown > 0) {
        const bTop = topPx + htPx;
        const bHt  = Math.min(minToPx(coolDown), minToPx(DAY_MINS) - bTop);
        if (bHt > 0) {
          h += `<div class="buffer-block" data-job-id="${job.id}" data-buffer-type="cooldown" style="top:${bTop}px;height:${bHt}px;${splitStyle}${bufStyle}">${bHt >= 10 ? '<span class="buffer-label">Cool-down</span>' : ''}</div>`;
        }
      }
    });

    h += '</div>'; // .day-printer-col
  });

  h += '</div>'; // .day-view-body
  h += '</div>'; // .day-view-scroll
  h += '</div>'; // .day-view

  // Capture scroll RIGHT before replacing innerHTML — any earlier render's
  // scrollToNow may have applied a centred position during our /api/jobs
  // await, and we want to preserve whatever the user's currently looking at.
  const prevScrollTop = document.getElementById('day-scroll')?.scrollTop ?? 0;

  container.innerHTML = h;

  // On the very first render #day-scroll didn't exist yet, so computeDayScale()
  // used an estimate. Now that it's in the DOM we can measure it exactly; if the
  // ideal density differs, re-render once with the correct scale. The guard stops
  // this recursing more than a single corrective pass.
  if (!dayScaleCorrecting) {
    const ideal = computeDayScale();
    if (Math.abs(ideal - PX_PER_MIN) > 0.02) {
      dayScaleCorrecting = true;
      try { await renderDay(); } finally { dayScaleCorrecting = false; }
      return;
    }
  }

  // Restore the previous scroll position so SSE re-renders don't reset
  // the user's scroll. If an explicit centre-on-now is pending (Today
  // button, first load, etc.) the rAF scrollToNow at the end of this
  // function will override this.
  if (!pendingScrollToNow && prevScrollTop) {
    const newScroll = document.getElementById('day-scroll');
    if (newScroll) newScroll.scrollTop = prevScrollTop;
  }

  // Now-line
  if (sameDay(new Date(), navDate)) {
    const now    = new Date();
    const nowPx  = minToPx(now.getHours() * 60 + now.getMinutes());
    document.querySelectorAll('.day-printer-col').forEach(col => {
      const line = document.createElement('div');
      line.className = 'now-line';
      line.style.top = `${nowPx}px`;
      col.appendChild(line);
    });
  }

  // Mobile: render printer switcher tabs & activate single column
  renderMobilePrinterSwitcher(visiblePrinters);

  attachDayEvents();
}

// Snap a MINUTE offset to the nearest 15-min boundary. Callers convert pixels
// to minutes via pxToMin() before snapping.
function snap15(mins) { return Math.round(mins / 15) * 15; }

// Returns a start position (in minutes) that avoids overlapping any other job's buffer zone on the same printer column.
function snapAvoidingJobs(proposedStart, durationMins, printerId, excludeJobId) {
  const printer = printers.find(p => p.id === printerId);
  // The dragged job's own snapshotted warm-up and cool-down (fall back to the
  // printer scalar, then the code default) — never the printer scalar alone.
  const movingJob = jobsCache[excludeJobId];
  const myWu    = movingJob?.warm_up_mins  ?? printer?.warm_up_mins  ?? 0;
  const myCd    = movingJob?.cool_down_mins ?? printer?.cool_down_mins ?? 15;

  const dayS = new Date(navDate); dayS.setHours(0,0,0,0);

  // Build list of occupied intervals (excluding the dragged job itself). Each
  // interval's trailing buffer uses that job's OWN cool_down_mins, so the snap
  // gap matches the per-job server schedule (finishing job owns the gap).
  const intervals = Object.values(jobsCache)
    .filter(j => !j.queued && j.printerId === printerId && j.id !== excludeJobId)
    .map(j => {
      const s = (new Date(j.start).getTime() - dayS.getTime()) / 60_000;
      const e = (new Date(j.end).getTime()   - dayS.getTime()) / 60_000;
      const jCd = j.cool_down_mins ?? printer?.cool_down_mins ?? 15;
      const jWu = j.warm_up_mins ?? printer?.warm_up_mins ?? 0;
      return { start: s - jWu, end: e + jCd };
    });

  // My occupied interval
  const myStart = proposedStart - myWu;
  const myEnd   = proposedStart + durationMins + myCd;

  for (const iv of intervals) {
    if (myStart < iv.end && myEnd > iv.start) {
      // Overlap detected: snap to the nearest boundary
      const snapBefore = iv.start - durationMins - myCd; // place my job just before this one
      const snapAfter  = iv.end   + myWu;                // place my job just after this one
      const distBefore = Math.abs(proposedStart - snapBefore);
      const distAfter  = Math.abs(proposedStart - snapAfter);
      return Math.max(0, distBefore < distAfter ? snapBefore : snapAfter);
    }
  }
  return proposedStart;
}

function updateDragPreview() {
  if (!drag) return;
  const { anchorMins, currentMins, previewEl, printerId } = drag;
  const startMins = Math.min(anchorMins, currentMins);
  const endMins   = Math.max(Math.max(anchorMins, currentMins), startMins + 15);
  const durMins   = endMins - startMins;
  const printer   = printers.find(p => p.id === printerId);
  const color     = printer?.color ?? '#0f766e';

  previewEl.style.top             = minToPx(startMins) + 'px';
  previewEl.style.height          = minToPx(durMins) + 'px';
  previewEl.style.background      = hexRgba(color, 0.22);
  previewEl.style.borderLeftColor = color;

  const h = Math.floor(durMins / 60), m = durMins % 60;
  previewEl.textContent = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

// bottomMins: how far down the drag reaches, in MINUTES. Converted to px here.
function expandDayBodyForDrag(bottomMins) {
  const body = document.querySelector('.day-view-body');
  if (!body) return;
  const needed = Math.max(minToPx(bottomMins) + 40, minToPx(DAY_MINS));
  if (needed > parseFloat(body.style.height)) body.style.height = needed + 'px';
}

function onDragMove(e) {
  if (!drag) return;
  // Snap-to-avoid-overlap is opt-in: hold CTRL (or Cmd on Mac) to snap a drop
  // clear of other jobs' print windows. Without a modifier, drops are free —
  // the job lands at the dropped time (still on the 15-min grid).
  const wantSnap = !!(e && (e.ctrlKey || e.metaKey));

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

    // A printer-bound queued job only accepts its OWN lane; hovering any other
    // printer's column is treated as "no valid target" (no preview, no drop).
    // Unassigned queue jobs (null printerId) keep the freedom to land on any lane
    // — dropping one there is how a printer gets assigned.
    const qJob = jobsCache[drag.jobId];
    const blockedLane = targetCol && qJob && qJob.printerId != null
      && parseInt(targetCol.dataset.printerId) !== qJob.printerId;

    if (targetCol && !blockedLane) {
      const rect  = targetCol.getBoundingClientRect();
      const proposed = snap15(Math.max(0, Math.min(pxToMin(e.clientY - rect.top), DAY_MINS + 240 - drag.durationMins)));
      drag.printerId = parseInt(targetCol.dataset.printerId);
      // Avoid landing on top of an existing job's warm-up / cool-down buffer
      // on the same printer column (opt-in via CTRL/Cmd). Mirrors the "move"
      // branch so queue-drag drops don't ignore pre/post print time when snapping.
      const snapped = wantSnap
        ? snapAvoidingJobs(proposed, drag.durationMins, drag.printerId, drag.jobId)
        : proposed;
      const y = Math.max(0, Math.min(snapped, DAY_MINS + 240 - drag.durationMins));
      drag.currentMins = y;

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
      previewEl.style.top             = minToPx(y) + 'px';
      previewEl.style.height          = minToPx(durationMins) + 'px';
      expandDayBodyForDrag(y + durationMins);
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
    const y = Math.max(0, Math.min(pxToMin(e.clientY - rect.top), DAY_MINS));
    drag.currentMins = snap15(y);
    if (Math.abs(drag.currentMins - drag.anchorMins) >= 15) drag.moved = true;
    updateDragPreview();
    return;
  }

  if (drag.type === 'move') {
    // Check if cursor is over a different printer column
    const allCols = document.querySelectorAll('.day-printer-col');
    let hoveredCol = drag.colEl;
    allCols.forEach(col => {
      const r = col.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right) hoveredCol = col;
    });

    if (hoveredCol !== drag.colEl) {
      // A printer-bound job is LOCKED to its own lane: reject a cross-lane hover so
      // an accidental sideways drag can't rebind it. Reassigning to another printer
      // is deliberate — via the job editor's Printer field or the "Move to another
      // printer" context-menu action, never a stray drag. Every scheduled job has a
      // printerId, so this blocks cross-lane drag for all of them; unassigned QUEUE
      // jobs (dragged in from the queue) still land on any lane. Flagged for Dirk.
      const hoveredPrinterId = parseInt(hoveredCol.dataset.printerId);
      if (drag.job.printerId != null && hoveredPrinterId !== drag.job.printerId) {
        // stay locked — ignore the cross-lane hover, keep the job in its own column
      } else {
        // Move the job element to the new column
        hoveredCol.appendChild(drag.jobEl);
        if (drag.warmUpEl)   hoveredCol.appendChild(drag.warmUpEl);
        if (drag.coolDownEl) hoveredCol.appendChild(drag.coolDownEl);
        drag.colEl = hoveredCol;
        drag.printerId = hoveredPrinterId;
      }
    }

    const rect = drag.colEl.getBoundingClientRect();
    const y    = snap15(Math.max(0, Math.min(pxToMin(e.clientY - rect.top), DAY_MINS + 240)));

    const base    = snap15(Math.max(0, Math.min(y - drag.offsetMins, DAY_MINS + 240 - drag.durationMins)));
    const snapped = wantSnap
      ? snapAvoidingJobs(base, drag.durationMins, drag.printerId, drag.jobId)
      : base;
    const newTop  = Math.max(0, Math.min(snapped, DAY_MINS + 240 - drag.durationMins));
    if (Math.abs(newTop - drag.currentTopMins) >= 1) drag.moved = true;
    drag.currentTopMins = newTop;
    drag.jobEl.style.top = minToPx(newTop) + 'px';
    drag.jobEl.style.opacity = '0.75';
    drag.jobEl.style.zIndex  = '10';
    expandDayBodyForDrag(newTop + drag.durationMins);
    if (drag.warmUpEl) {
      const bTop = Math.max(0, newTop - drag.warmUpMins);
      const bHt  = newTop - bTop;
      drag.warmUpEl.style.top    = minToPx(bTop) + 'px';
      drag.warmUpEl.style.height = minToPx(bHt)  + 'px';
    }
    if (drag.coolDownEl) {
      drag.coolDownEl.style.top = minToPx(newTop + drag.durationMins) + 'px';
    }
    return;
  }

  const rect = drag.colEl.getBoundingClientRect();
  const y    = snap15(Math.max(0, Math.min(pxToMin(e.clientY - rect.top), DAY_MINS + 240)));

  if (drag.type === 'resize') {
    const newEnd = Math.max(drag.startMins + 15, y);
    if (Math.abs(newEnd - drag.currentEndMins) >= 1) drag.moved = true;
    drag.currentEndMins = newEnd;
    drag.jobEl.style.height  = minToPx(newEnd - drag.startMins) + 'px';
    drag.jobEl.style.opacity = '0.75';
    expandDayBodyForDrag(newEnd);
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
    if (scr) scr.scrollTop = Math.max(0, minToPx(currentMins) - 120);
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
  const { type, jobId, job, moved, currentTopMins, currentEndMins, startMins, jobEl, printerId: dragPrinterId } = drag;
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
    await api('PATCH', `/api/jobs/${jobId}`, { printerId: dragPrinterId, start: toDatetimeLocal(newStart), end: toDatetimeLocal(newEnd) });
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
  // Click job → edit  |  right-click / long-press → context menu  |  mousedown → move
  document.querySelectorAll('.job-block').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      if (lastDragMoved) { lastDragMoved = false; return; }
      openJobModal(parseInt(el.dataset.jobId));
    });
    el.addEventListener('contextmenu', e => showCtxMenu(e, parseInt(el.dataset.jobId)));

    // Long-press on touch → bottom sheet
    addLongPress(el, () => {
      showBottomSheet(parseInt(el.dataset.jobId));
    });

    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('.job-resize-handle')) return;
      e.stopPropagation();

      const jobId   = parseInt(el.dataset.jobId);
      const job     = jobsCache[jobId];
      if (!job) return;
      if (job.locked) return; // locked jobs are immovable — no drag
      const colEl   = el.closest('.day-printer-col');
      const colRect = colEl.getBoundingClientRect();
      const elRect  = el.getBoundingClientRect();
      const topMins = pxToMin(elRect.top - colRect.top);
      const printer = printers.find(p => p.id === parseInt(colEl.dataset.printerId));

      drag = {
        type: 'move',
        jobEl: el,
        jobId,
        colEl,
        job,
        offsetMins: snap15(pxToMin(e.clientY - elRect.top)),
        currentTopMins: topMins,
        durationMins: Math.round((new Date(job.end) - new Date(job.start)) / 60_000),
        moved: false,
        warmUpEl:     colEl.querySelector(`.buffer-block[data-job-id="${jobId}"][data-buffer-type="warmup"]`),
        coolDownEl:   colEl.querySelector(`.buffer-block[data-job-id="${jobId}"][data-buffer-type="cooldown"]`),
        warmUpMins:   job.warm_up_mins ?? printer?.warm_up_mins ?? 0,
        coolDownMins: job.cool_down_mins ?? printer?.cool_down_mins ?? 15,
        printerId:    printer?.id ?? job.printerId,
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
      if (job.locked) return; // locked jobs are immovable — no resize
      const colEl  = jobEl.closest('.day-printer-col');
      const colRect = colEl.getBoundingClientRect();
      const elRect  = jobEl.getBoundingClientRect();
      const startMins = pxToMin(elRect.top - colRect.top);

      drag = {
        type: 'resize',
        jobEl,
        jobId,
        colEl,
        job,
        startMins,
        currentEndMins: pxToMin(elRect.bottom - colRect.top),
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
      const anchorMins = snap15(Math.max(0, pxToMin(e.clientY - rect.top)));
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

  // Apply mobile single-column mode
  applyMobilePrinterFilter();
  attachMobileDayViewSwipe();

  // Auto-centre the now-line if requested (Today button, view switch,
  // first load). Deferred to the next frame so layout is stable. The
  // flag is NOT cleared until the rAF has actually applied the scroll —
  // this matters when a second render (e.g. the first SSE status burst)
  // runs before the first render's rAF fires. The concurrent render
  // sees pending=true, skips its "restore previous scrollTop" step, and
  // both rAFs end up scrolling the most recent day-scroll element to
  // the same centred position.
  if (pendingScrollToNow) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scrollToNow();
      pendingScrollToNow = false;
    }));
  }
}

// Auto-centre the current hour in the day view — but only when the user is
// actually viewing today. If they navigated to a past/future day, leave the
// scroll at its natural top so they can see the start of that day.
function scrollToNow() {
  const scroll = document.getElementById('day-scroll');
  if (!scroll) return;
  const nav = navDate;
  const today = todayMidnight();
  if (nav.getFullYear() !== today.getFullYear() ||
      nav.getMonth()    !== today.getMonth()    ||
      nav.getDate()     !== today.getDate()) {
    return;
  }
  const now = new Date();
  // Exact pixel position of the now-line inside the scrollable content, at the
  // current grid scale.
  const nowPx = minToPx(now.getHours() * 60 + now.getMinutes());
  const viewport = scroll.clientHeight;
  // Centre the now-line. Browser clamps the bottom edge automatically; we
  // clamp the top so early mornings don't try to scroll above 0.
  scroll.scrollTop = Math.max(0, nowPx - viewport / 2);
}

// Mobile: swipe left/right on the day view to switch between printer tabs.
// Only attached when we're in the single-column mobile layout. Ignores gestures
// that start on a job block (those belong to the drag-to-move handler).
function attachMobileDayViewSwipe() {
  if (!isMobileView()) return;
  const scroll = document.getElementById('day-scroll');
  if (!scroll || scroll.dataset.swipeBound === '1') return;
  scroll.dataset.swipeBound = '1';

  const SWIPE_MIN_PX = 60;     // horizontal distance required
  const SWIPE_MAX_OFF_AXIS = 40; // max vertical drift — more than this = vertical scroll
  const SWIPE_MAX_DURATION = 600;

  let sx = 0, sy = 0, t0 = 0, active = false;

  scroll.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { active = false; return; }
    // Don't swipe if the user is grabbing a job block / buffer / resize handle.
    if (e.target.closest('.job-block, .buffer-block, .job-resize-handle')) { active = false; return; }
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    t0 = Date.now();
    active = true;
  }, { passive: true });

  scroll.addEventListener('touchend', e => {
    if (!active) return;
    active = false;
    const t  = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    const dt = Date.now() - t0;
    if (dt > SWIPE_MAX_DURATION) return;
    if (Math.abs(dx) < SWIPE_MIN_PX) return;
    if (Math.abs(dy) > SWIPE_MAX_OFF_AXIS) return;
    // Horizontal swipe — switch printer tab
    const visible = printers.filter(p => p.favourite);
    if (visible.length < 2) return;
    const dir = dx < 0 ? 1 : -1; // swipe left → next, swipe right → prev
    mobilePrinterIdx = (mobilePrinterIdx + dir + visible.length) % visible.length;
    renderCalendar();
  }, { passive: true });
}

function updateNowLine() {
  const lines = document.querySelectorAll('.now-line');
  if (!lines.length) return;
  const now   = new Date();
  const nowPx = minToPx(now.getHours() * 60 + now.getMinutes());
  lines.forEach(line => { line.style.top = `${nowPx}px`; });
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
  rebuildJobsCache(allJobs);
  const today    = todayMidnight();

  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  let h = `<div class="week-view"><table class="week-table" style="--week-rows:${printers.length}"><thead><tr>`;
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
                         color:var(--text);
                         border-left-color:${p.color}">
                  <span class="chip-status-dot" style="background:${statusCol}"></span>${job.orderNr ? `#${escHtml(job.orderNr)} — ` : ''}${escHtml(job.name)}
                </span>`;
        });
      h += '</td>';
    });
    h += '</tr>';
  });

  h += '</tbody></table></div>';

  // Skip the DOM rebuild when the markup is byte-identical to what's shown — a
  // no-op SSE re-render would otherwise destroy the .week-view scroll container
  // and reset scrollTop to 0. The querySelector guard forces a rebuild after a
  // view switch. Mirrors renderUpcoming/renderMonth.
  if (h === lastWeekHtml && container.querySelector('.week-view')) return;
  lastWeekHtml = h;

  const prevScrollTop = container.querySelector('.week-view')?.scrollTop ?? 0;

  container.innerHTML = h;

  if (prevScrollTop) {
    const viewEl = container.querySelector('.week-view');
    if (viewEl) viewEl.scrollTop = prevScrollTop;
  }

  // Click chip → edit  |  right-click → context menu
  document.querySelectorAll('.week-job-chip').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      openJobModal(parseInt(el.dataset.jobId));
    });
    el.addEventListener('contextmenu', e => showCtxMenu(e, parseInt(el.dataset.jobId)));
    addLongPress(el, () => showBottomSheet(parseInt(el.dataset.jobId)));
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
  rebuildJobsCache(allJobs);
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
                      color:var(--text);
                      border-left-color:${p.color}">
               <span class="chip-status-dot" style="background:${statusCol}"></span>${job.orderNr ? `#${escHtml(job.orderNr)} — ` : ''}${escHtml(job.name)}${job.customerName ? `<span class="month-chip-customer"> · ${escHtml(job.customerName)}</span>` : ''}
             </span>`;
    });
    h += '</div>';
  });

  h += '</div></div>';

  // Skip the DOM rebuild when the markup is byte-identical to what's shown — a
  // no-op SSE re-render would otherwise destroy the .month-view scroll container
  // and reset scrollTop to 0. The querySelector guard forces a rebuild after a
  // view switch. Mirrors renderUpcoming/renderWeek.
  if (h === lastMonthHtml && container.querySelector('.month-view')) return;
  lastMonthHtml = h;

  const prevScrollTop = container.querySelector('.month-view')?.scrollTop ?? 0;

  container.innerHTML = h;

  if (prevScrollTop) {
    const viewEl = container.querySelector('.month-view');
    if (viewEl) viewEl.scrollTop = prevScrollTop;
  }

  // Click chip → edit  |  right-click → context menu
  document.querySelectorAll('.month-job-chip').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      openJobModal(parseInt(el.dataset.jobId));
    });
    el.addEventListener('contextmenu', e => showCtxMenu(e, parseInt(el.dataset.jobId)));
    addLongPress(el, () => showBottomSheet(parseInt(el.dataset.jobId)));
  });

  document.querySelectorAll('.month-day-cell').forEach(cell => {
    cell.addEventListener('click', e => {
      if (e.target.closest('.month-job-chip')) return;
      navDate = new Date(cell.dataset.date + 'T00:00:00');
      view    = 'day';
      pendingScrollToNow = true;
      syncUrlToState();
      renderCalendar();
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
  rebuildJobsCache(allJobs);

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
      h += `<div class="upcoming-day-header${isToday ? ' upcoming-day-today' : ''}" data-date="${toDateKey(day)}" style="cursor:pointer">${fmtDate(day, 'DDDD, D MMMM YYYY')}</div>`;
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

  // Skip the DOM rebuild entirely when the markup is byte-identical to what's
  // already shown. Background SSE frames (renderCalendar → renderUpcoming) fire
  // every few seconds; when nothing changed, rebuilding innerHTML would destroy
  // the .upcoming-view scroll container and reset scrollTop to 0, yanking the
  // user back to the top mid-edit. The querySelector guard forces a rebuild
  // after a view switch (container no longer holds .upcoming-view even if the
  // cached HTML matches).
  if (h === lastUpcomingHtml && container.querySelector('.upcoming-view')) return;
  lastUpcomingHtml = h;

  // When the data DID change, preserve scroll across the innerHTML swap so the
  // re-render doesn't reset the user's position (mirrors renderDay's approach).
  const prevScrollTop = container.querySelector('.upcoming-view')?.scrollTop ?? 0;

  container.innerHTML = h;

  if (prevScrollTop) {
    const viewEl = container.querySelector('.upcoming-view');
    if (viewEl) viewEl.scrollTop = prevScrollTop;
  }

  container.querySelectorAll('.upcoming-job-row[data-job-id]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      openJobModal(parseInt(el.dataset.jobId));
    });
    el.addEventListener('contextmenu', e => showCtxMenu(e, parseInt(el.dataset.jobId)));
    addLongPress(el, () => showBottomSheet(parseInt(el.dataset.jobId)));
  });

  // Click day header → jump to that day in day view
  container.querySelectorAll('.upcoming-day-header[data-date]').forEach(el => {
    el.addEventListener('click', () => {
      navDate = new Date(el.dataset.date + 'T00:00:00');
      view = 'day';
      pendingScrollToNow = true;
      syncUrlToState();
      renderCalendar();
    });
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
// Mobile helpers
// =============================================================================
function isMobileView() { return window.innerWidth <= 480; }

// Detect touch device on first touch
document.addEventListener('touchstart', () => { isTouchDevice = true; }, { once: true, passive: true });

// ---- Link menu state (shared by desktop ctx-menu + mobile bottom sheet) ----
const LINK_START_WINDOW_MS = 24 * 60 * 60 * 1000; // mirror awaiting-printer.WINDOW_MS

// A job is eligible to pre-link ("Link when printer starts") only when its
// start is within 24h of now (past or future). Server enforces this too; this
// is UX-only so the option is hidden when it would be rejected.
function isStartWithinLinkWindow(startISO) {
  if (!startISO) return false;
  const t = new Date(startISO).getTime();
  if (Number.isNaN(t)) return false;
  const now = Date.now();
  return t >= now - LINK_START_WINDOW_MS && t <= now + LINK_START_WINDOW_MS;
}

// Decide the single link/unlink/prelink/cancel item to show for a job, or null
// to hide it. Keeps desktop + mobile menus in lockstep.
function jobLinkMenuState(job) {
  if (!job) return null;
  const printer = printers.find(p => p.id === job.printerId);
  const isRunning = getPrinterLiveStatus(printer)?.stage === 'RUNNING';
  if (job.status === 'Awaiting Printer') {
    return { label: '🔗 Cancel auto-link', action: 'cancel-await' };
  }
  if (job.linked_printer_id) {
    return { label: '🔗 Unlink from printer', action: 'unlink' };
  }
  if (isRunning) {
    const printerBusy = Object.values(jobsCache)
      .some(j => j.id !== job.id && j.linked_printer_id === printer?.id);
    return printerBusy ? null : { label: '🔗 Link to printer', action: 'link' };
  }
  // Printer idle/preparing → offer pre-link if the job is eligible and the
  // printer has no other job already waiting to auto-link.
  const hasPending = Object.values(jobsCache).some(
    j => j.id !== job.id && j.status === 'Awaiting Printer' && j.linked_printer_id === printer?.id
  );
  if (!hasPending && isStartWithinLinkWindow(job.start)) {
    return { label: '🔗 Link when printer starts', action: 'prelink' };
  }
  return null;
}

// Lock/unlock context-menu state. The lock is toggled ONLY here (context menu),
// never from the edit dialog. Hidden while the job is Printing or Awaiting
// Printer — the lock state is frozen in those states. An unlocked job shows
// "Lock" (closed padlock); a locked job shows "Unlock" (open padlock).
function jobLockMenuState(job) {
  if (!job) return null;
  if (job.status === 'Printing' || job.status === 'Awaiting Printer') return null;
  return job.locked
    ? { label: '🔓 Unlock', action: 'unlock' }
    : { label: '🔒 Lock', action: 'lock' };
}

// Toggle a job's lock state via the context menu. Optimistically updates the
// cache so the next render shows the icon immediately.
async function applyLockAction(jobId, action) {
  const locked = action === 'lock' ? 1 : 0;
  try {
    await api('PATCH', `/api/jobs/${jobId}`, { locked });
    if (jobsCache[jobId]) jobsCache[jobId].locked = locked;
    return true;
  } catch (err) {
    let msg = err.message;
    try { msg = JSON.parse(err.message).error || msg; } catch { /* raw text */ }
    alert(msg);
    return false;
  }
}

// Apply a chosen link action (link / unlink / prelink / cancel-await) for a
// job id. Returns true on success; surfaces server rejections via alert.
async function applyLinkAction(jobId, action) {
  const job = jobsCache[jobId];
  try {
    if (action === 'unlink') {
      await api('PATCH', `/api/jobs/${jobId}`, { linked_printer_id: null });
    } else if (action === 'cancel-await') {
      await api('PATCH', `/api/jobs/${jobId}`, { linked_printer_id: null, status: 'Planned' });
    } else if (action === 'prelink') {
      await api('PATCH', `/api/jobs/${jobId}`, { linked_printer_id: job?.printerId ?? null, status: 'Awaiting Printer' });
    } else {
      await api('PATCH', `/api/jobs/${jobId}`, { linked_printer_id: job?.printerId ?? null, status: 'Printing' });
    }
    return true;
  } catch (err) {
    let msg = err.message;
    try { msg = JSON.parse(err.message).error || msg; } catch { /* raw text */ }
    alert(msg);
    return false;
  }
}

// Which of the four "push/pull toward now" job options should be offered for a
// given job. Shared by the desktop context menu and the mobile bottom sheet so
// both stay in lock-step.
//   - Push back to now: pointless once the job's start is already in the past.
//   - Pull forward to now: pointless for a job still scheduled in the future.
//   - All four: hidden for jobs anchored to a printer rather than a chosen slot
//     — currently Printing, linked to a printer, or Awaiting Printer — and for
//     unscheduled (queued) jobs, which have no start to move.
function pushOptionVisibility(job, now = Date.now()) {
  const anchored = !job
    || job.status === 'Printing'
    || job.status === 'Awaiting Printer'
    || job.linked_printer_id != null
    || !!job.queued
    || !!job.locked; // locked jobs are immovable — no push/pull options
  if (anchored) {
    return { pushNow: false, pushTo: false, pullNow: false, pullTo: false };
  }
  const startMs = job.start ? new Date(job.start).getTime() : NaN;
  const startInPast   = Number.isFinite(startMs) && startMs < now;
  const startInFuture = Number.isFinite(startMs) && startMs > now;
  return {
    // push back to now = move a PAST start later, up to now → past jobs only.
    pushNow: startInPast,
    pushTo: true,
    // pull forward to now = move a FUTURE start earlier, to now → future only.
    pullNow: startInFuture,
    pullTo: true,
  };
}

// Apply pushOptionVisibility to the four menu buttons under the given id prefix
// ('ctx' for the desktop menu, 'bs' for the bottom sheet).
function applyPushOptionVisibility(job, prefix) {
  const vis = pushOptionVisibility(job);
  const toggle = (id, show) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !show);
  };
  toggle(`${prefix}-push-now`, vis.pushNow);
  toggle(`${prefix}-push-to`,  vis.pushTo);
  toggle(`${prefix}-pull-now`, vis.pullNow);
  toggle(`${prefix}-pull-to`,  vis.pullTo);
}

// ---- Bottom sheet (mobile context menu) ----
let bsJobId = null;

function showBottomSheet(jobId) {
  bsJobId = jobId;
  const job = jobsCache[jobId];
  if (!job) return;

  // Header
  const header = document.getElementById('bs-header');
  header.textContent = job.orderNr ? `#${job.orderNr} — ${job.name}` : job.name;

  // Mark active status
  const currentStatus = job.status ?? 'Planned';
  document.querySelectorAll('.bs-status-btn').forEach(btn => {
    btn.classList.toggle('ctx-status-active', btn.dataset.status === currentStatus);
  });

  // Link / unlink / pre-link
  const linkItem = document.getElementById('bs-link-item');
  const linkSep  = document.getElementById('bs-link-sep');
  const linkState = jobLinkMenuState(job);
  if (linkState) {
    linkItem.classList.remove('hidden');
    linkSep.classList.remove('hidden');
    linkItem.textContent = linkState.label;
    linkItem.dataset.action = linkState.action;
  } else {
    linkItem.classList.add('hidden');
    linkSep.classList.add('hidden');
  }

  // Lock / unlock item
  const bsLockItem = document.getElementById('bs-lock-item');
  const bsLockSep  = document.getElementById('bs-lock-sep');
  const bsLockState = jobLockMenuState(job);
  if (bsLockState) {
    bsLockItem.classList.remove('hidden');
    bsLockSep.classList.remove('hidden');
    bsLockItem.textContent = bsLockState.label;
    bsLockItem.dataset.action = bsLockState.action;
  } else {
    bsLockItem.classList.add('hidden');
    bsLockSep.classList.add('hidden');
  }

  // Gate the push/pull-to-now options
  applyPushOptionVisibility(job, 'bs');

  // Conflict resolution in bottom sheet. Hidden for a locked (immovable) job.
  const bsConflict = document.getElementById('bs-conflict-section');
  if (bsConflict) {
    if (lastConflictIds.has(jobId) && !job.locked) bsConflict.classList.remove('hidden');
    else bsConflict.classList.add('hidden');
  }

  const overlay = document.getElementById('bottom-sheet-overlay');
  const sheet   = document.getElementById('bottom-sheet');
  overlay.classList.add('open');
  // Force reflow before adding open class for transition
  sheet.offsetHeight;
  sheet.classList.add('open');
}

function hideBottomSheet() {
  const overlay = document.getElementById('bottom-sheet-overlay');
  const sheet   = document.getElementById('bottom-sheet');
  sheet.classList.remove('open');
  overlay.classList.remove('open');
  bsJobId = null;
}

function setupBottomSheet() {
  document.getElementById('bottom-sheet-overlay').addEventListener('click', hideBottomSheet);
  // Swipe down to dismiss
  let startY = 0;
  const sheet = document.getElementById('bottom-sheet');
  sheet.addEventListener('touchstart', e => { startY = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    const dy = e.touches[0].clientY - startY;
    if (dy > 60) hideBottomSheet();
  }, { passive: true });

  document.getElementById('bs-edit').addEventListener('click', () => {
    if (bsJobId !== null) openJobModal(bsJobId);
    hideBottomSheet();
  });
  document.querySelectorAll('.bs-status-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (bsJobId !== null) {
        const scr = document.getElementById('day-scroll');
        const savedScroll = scr ? scr.scrollTop : 0;
        await api('PATCH', `/api/jobs/${bsJobId}`, { status: btn.dataset.status });
        await renderCalendar();
        refreshStatusOverviewIfOpen();
        await refreshOpenProjectViews();
        const scr2 = document.getElementById('day-scroll');
        if (scr2) scr2.scrollTop = savedScroll;
      }
      hideBottomSheet();
    });
  });
  // Bottom sheet conflict resolution
  document.getElementById('bs-move-after')?.addEventListener('click', async () => { const id = bsJobId; hideBottomSheet(); if (id !== null) await resolveConflictMoveAfter(id); });
  document.getElementById('bs-move-next-day')?.addEventListener('click', async () => { const id = bsJobId; hideBottomSheet(); if (id !== null) await resolveConflictNextDay(id); });
  document.getElementById('bs-move-printer')?.addEventListener('click', async () => { const id = bsJobId; hideBottomSheet(); if (id !== null) await resolveConflictMovePrinter(id); });

  document.getElementById('bs-assign-project').addEventListener('click', () => {
    const id = bsJobId;
    hideBottomSheet();
    if (id !== null) openAssignProject(id);
  });
  document.getElementById('bs-duplicate').addEventListener('click', () => {
    if (bsJobId !== null) duplicateJob(bsJobId);
    hideBottomSheet();
  });
  document.getElementById('bs-push-now')?.addEventListener('click', async () => {
    const id = bsJobId;
    hideBottomSheet();
    if (id !== null) await pushBackJob(id, null);
  });
  document.getElementById('bs-push-to')?.addEventListener('click', () => {
    const id = bsJobId;
    hideBottomSheet();
    if (id !== null) openPushBackModal(id);
  });
  document.getElementById('bs-pull-now')?.addEventListener('click', async () => {
    const id = bsJobId;
    hideBottomSheet();
    if (id !== null) await pullForwardJob(id, null, null);
  });
  document.getElementById('bs-pull-to')?.addEventListener('click', () => {
    const id = bsJobId;
    hideBottomSheet();
    if (id !== null) openPullForwardModal(id);
  });
  document.getElementById('bs-delete').addEventListener('click', async () => {
    if (bsJobId !== null && confirm('Delete this print job?')) {
      await api('DELETE', `/api/jobs/${bsJobId}`);
      renderCalendar();
    }
    hideBottomSheet();
  });
  document.getElementById('bs-link-item').addEventListener('click', async () => {
    if (bsJobId === null) return;
    const action = document.getElementById('bs-link-item').dataset.action;
    const id = bsJobId;
    hideBottomSheet();
    await applyLinkAction(id, action);
    renderCalendar();
  });
  document.getElementById('bs-lock-item').addEventListener('click', async () => {
    if (bsJobId === null) return;
    const action = document.getElementById('bs-lock-item').dataset.action;
    const id = bsJobId;
    hideBottomSheet();
    await applyLockAction(id, action);
    renderCalendar();
  });
}

// ---- Mobile printer switcher ----
function renderMobilePrinterSwitcher(visiblePrinters) {
  const container = document.getElementById('mobile-printer-switcher');
  if (!isMobileView() || !visiblePrinters.length) {
    container.innerHTML = '';
    return;
  }
  // Clamp index
  if (mobilePrinterIdx >= visiblePrinters.length) mobilePrinterIdx = 0;

  container.innerHTML = visiblePrinters.map((p, i) =>
    `<button class="mobile-printer-tab${i === mobilePrinterIdx ? ' active' : ''}"
             data-idx="${i}" style="${i === mobilePrinterIdx ? `border-bottom-color:${p.color};color:${p.color}` : ''}">${escHtml(p.name)}</button>`
  ).join('');

  container.querySelectorAll('.mobile-printer-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      mobilePrinterIdx = parseInt(btn.dataset.idx);
      renderCalendar();
    });
  });
}

function applyMobilePrinterFilter() {
  if (!isMobileView()) return;
  const cols = document.querySelectorAll('.day-printer-col');
  cols.forEach((col, i) => {
    col.classList.toggle('mobile-active', i === mobilePrinterIdx);
  });
}

// ---- Long-press handler for touch devices ----
function addLongPress(el, callback, duration = 500) {
  let timer = null;
  let triggered = false;

  el.addEventListener('touchstart', e => {
    triggered = false;
    timer = setTimeout(() => {
      triggered = true;
      // Light haptic feedback if available
      if (navigator.vibrate) navigator.vibrate(30);
      callback(e);
    }, duration);
  }, { passive: true });

  el.addEventListener('touchmove', () => {
    if (timer) { clearTimeout(timer); timer = null; }
  }, { passive: true });

  el.addEventListener('touchend', e => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (triggered) { e.preventDefault(); triggered = false; }
  });

  el.addEventListener('touchcancel', () => {
    if (timer) { clearTimeout(timer); timer = null; }
    triggered = false;
  }, { passive: true });
}

// ---- Touch drag support for day view ----
function onTouchDragMove(e) {
  if (!drag) return;
  const touch = e.touches[0];
  // Reuse the same logic as mouse drag
  onDragMove({ clientX: touch.clientX, clientY: touch.clientY, preventDefault() {} });
  e.preventDefault(); // prevent scroll while dragging
}

function onTouchDragEnd(e) {
  if (!drag) return;
  onDragEnd();
}

// =============================================================================
// Context menu
// =============================================================================
function showCtxMenu(e, jobId) {
  e.preventDefault();
  e.stopPropagation();

  // On touch devices, use the bottom sheet instead of the context menu
  if (isTouchDevice || isMobileView()) {
    showBottomSheet(jobId);
    return;
  }

  ctxJobId = jobId;

  // Mark active status
  const currentStatus = jobsCache[jobId]?.status ?? 'Planned';
  document.querySelectorAll('.ctx-status-btn').forEach(btn =>
    btn.classList.toggle('ctx-status-active', btn.dataset.status === currentStatus)
  );

  // Show link / unlink / pre-link option based on job + printer state
  const linkItem   = document.getElementById('ctx-link-item');
  const linkSep    = document.getElementById('ctx-link-sep');
  const linkState  = jobLinkMenuState(jobsCache[jobId]);
  if (linkState) {
    linkItem.classList.remove('hidden');
    linkSep.style.display = '';
    linkItem.textContent  = linkState.label;
    linkItem.dataset.action = linkState.action;
  } else {
    linkItem.classList.add('hidden');
    linkSep.style.display = 'none';
  }

  // Lock / unlock item
  const lockItem = document.getElementById('ctx-lock-item');
  const lockSep  = document.getElementById('ctx-lock-sep');
  const lockState = jobLockMenuState(jobsCache[jobId]);
  if (lockState) {
    lockItem.classList.remove('hidden');
    lockSep.style.display = '';
    lockItem.textContent = lockState.label;
    lockItem.dataset.action = lockState.action;
  } else {
    lockItem.classList.add('hidden');
    lockSep.style.display = 'none';
  }

  // Gate the push/pull-to-now options
  applyPushOptionVisibility(jobsCache[jobId], 'ctx');

  // Show/hide conflict resolution options. A locked job is immovable, so the
  // conflict-resolution moves never apply to it.
  const conflictSection = document.getElementById('ctx-conflict-section');
  if (lastConflictIds.has(jobId) && !jobsCache[jobId]?.locked) {
    conflictSection.classList.remove('hidden');
  } else {
    conflictSection.classList.add('hidden');
  }

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

// --- Queue item context menu (bound-printer scheduling) ---
let queueCtxJobId = null;
function showQueueCtxMenu(e, jobId) {
  e.preventDefault();
  e.stopPropagation();
  queueCtxJobId = jobId;
  const menu = document.getElementById('queue-ctx-menu');
  menu.style.left = e.clientX + 'px';
  menu.style.top  = e.clientY + 'px';
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  if (rect.right  > window.innerWidth)  menu.style.left = (e.clientX - rect.width)  + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top  = (e.clientY - rect.height) + 'px';
}
function hideQueueCtxMenu() {
  document.getElementById('queue-ctx-menu').classList.add('hidden');
  queueCtxJobId = null;
}

// Move a queued, printer-bound job onto its printer's timeline. `mode` is
// 'earliest' (next free slot, never reshuffles) or 'at' (verbatim at `to`,
// default now, reshuffling behind it). Reuses the SAME reshove confirm dialog as
// push-back / pull-forward: a needsReshove response opens confirmReshove and, on
// confirm, retries with reshove:true (pinning the server's target for to-now).
async function scheduleQueueJob(jobId, mode, to) {
  try {
    const body = { mode };
    if (mode === 'at' && to) body.to = to;
    let res = await api('POST', `/api/jobs/${jobId}/schedule-from-queue`, body);
    if (res && res.needsReshove) {
      const ok = await confirmReshove();
      if (!ok) return;
      res = await api('POST', `/api/jobs/${jobId}/schedule-from-queue`,
        { mode: 'at', to: to || res.target, reshove: true });
    }
    await renderCalendar();
    notifyActiveConflict(res);
  } catch (err) {
    alert('Scheduling failed: ' + (err.message || 'Unknown error'));
  }
}

let _queueAtJobId = null;
function openQueueAtModal(jobId) {
  _queueAtJobId = jobId;
  const input = document.getElementById('queue-at-datetime');
  input.value = toDatetimeLocal(new Date());
  document.getElementById('queue-at-modal').classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}
function closeQueueAtModal() {
  document.getElementById('queue-at-modal').classList.add('hidden');
  _queueAtJobId = null;
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

// Push back this job (and any Planned jobs after it on the same printer) to the given
// datetime. If `to` is null, the server uses the current moment. Silent hours and
// pre/post-processing buffers are honored server-side.
async function pushBackJob(jobId, to) {
  try {
    const body = to ? { to } : {};
    const res = await performTimedMove({ api, path: `/api/jobs/${jobId}/push-back`, body, confirmReshove });
    if (res.cancelled) return;
    await renderCalendar();
    notifyActiveConflict(res);
    if (res && res.updatedCount === 0 && !res.reshoved) {
      // Nothing moved — likely because the requested time is earlier than the current start.
      alert('Nothing to push: the selected time is earlier than the job\u2019s current start.');
    }
  } catch (e) {
    alert('Push back failed: ' + (e.message || 'Unknown error'));
  }
}

let _pushBackJobId = null;
function openPushBackModal(jobId) {
  _pushBackJobId = jobId;
  const input = document.getElementById('pushback-datetime');
  const job = jobsCache[jobId];
  // Default: the later of "now" and the job's current start.
  const now = new Date();
  const current = job?.start ? new Date(job.start) : now;
  const defaultDate = now > current ? now : current;
  input.value = toDatetimeLocal(defaultDate);
  document.getElementById('pushback-modal').classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}

function closePushBackModal() {
  document.getElementById('pushback-modal').classList.add('hidden');
  _pushBackJobId = null;
}

// Pull this job + any Planned jobs after it within the window forward
// (tight-pack) starting at the given datetime. `to` and `windowEnd` may be
// null; the server then uses defaults (to=now, windowEnd=to+24h).
async function pullForwardJob(jobId, to, windowEnd, moveChain) {
  try {
    const body = {};
    if (to) body.to = to;
    if (windowEnd) body.windowEnd = windowEnd;
    if (moveChain) body.moveChain = true;
    const res = await performTimedMove({ api, path: `/api/jobs/${jobId}/pull-forward`, body, confirmReshove });
    if (res.cancelled) return;
    await renderCalendar();
    notifyActiveConflict(res);
    if (res && res.updatedCount === 0 && !res.reshoved) {
      alert('Nothing to pull forward: the selected time isn\u2019t earlier than the job\u2019s current start, or nothing can move any earlier.');
    }
  } catch (e) {
    alert('Pull forward failed: ' + (e.message || 'Unknown error'));
  }
}

let _pullForwardJobId = null;
function openPullForwardModal(jobId) {
  _pullForwardJobId = jobId;
  const startInput = document.getElementById('pullforward-datetime');
  const endInput   = document.getElementById('pullforward-window-end');
  const toggle     = document.getElementById('pullforward-window-toggle');
  const windowRow  = document.getElementById('pullforward-window-row');
  const chainToggle = document.getElementById('pullforward-chain-toggle');
  // Default start = now. The user's most common intent is "tighten toward now".
  const now = new Date();
  startInput.value = toDatetimeLocal(now);
  // Default = NO end time (force the exact start + reshuffle). The toggle reveals
  // the window-end field for the fit-into-a-gap mode.
  toggle.checked = false;
  windowRow.classList.add('hidden');
  // Default = move only the anchor. The toggle drags the following chain along.
  if (chainToggle) chainToggle.checked = false;
  endInput.value = toDatetimeLocal(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  document.getElementById('pullforward-modal').classList.remove('hidden');
  setTimeout(() => startInput.focus(), 50);
}

function closePullForwardModal() {
  document.getElementById('pullforward-modal').classList.add('hidden');
  _pullForwardJobId = null;
}

// Custom confirm dialog shown when a timed move can't land at the requested slot
// without reshuffling. Resolves true if the user opts to re-shove the schedule.
let _reshoveResolve = null;
function confirmReshove() {
  return new Promise((resolve) => {
    _reshoveResolve = resolve;
    document.getElementById('reshove-modal').classList.remove('hidden');
  });
}
function closeReshoveModal(confirmed) {
  document.getElementById('reshove-modal').classList.add('hidden');
  const resolve = _reshoveResolve;
  _reshoveResolve = null;
  if (resolve) resolve(!!confirmed);
}

// After a start-time move is applied, warn if the moved job now overlaps a
// running / immovable print. The immovable job is never moved; this is a notice
// only, so Dirk can decide what to do about the conflict.
function notifyActiveConflict(res) {
  if (res && res.activeConflict) {
    alert('Heads up: this job now overlaps a running print on the same printer. The running job was left in place — resolve the conflict manually if needed.');
  }
}

async function duplicateJob(jobId) {
  const job = await api('GET', `/api/jobs/${jobId}`);
  if (!job) return;
  const now = new Date();
  const durMs = job.start && job.end ? new Date(job.end) - new Date(job.start)
              : (job.durationMins ?? 0) * 60_000;
  const end = durMs > 0 ? toDatetimeLocal(new Date(now.getTime() + durMs)) : '';
  openJobModal(null, {
    printerId:    job.printerId,
    name:         job.name + ' (copy)',
    start:        toDatetimeLocal(now),
    end:          end,
    durationMins: job.durationMins || (durMs > 0 ? Math.round(durMs / 60_000) : 0),
    customerName: job.customerName,
    orderNr:      job.orderNr,
    colors:       job.colors,
    printFile:    job.printFile,
    remarks:      job.remarks,
    status:       job.status,
    cool_down_mins: job.cool_down_mins,
    warm_up_mins: job.warm_up_mins,
    queued:       false,
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
    const titleText = scheduleMode ? 'Schedule Job' : isQueued ? 'Edit Queued Job' : 'Edit Print Job';
    // Show the lock state in the dialog title (read-only indicator; the lock is
    // toggled only from the context menu, never here).
    title.textContent = titleText;
    if (job.locked) {
      title.insertAdjacentHTML('afterbegin', '<span class="job-lock-icon" title="Locked — immovable" style="margin-right:6px">🔒</span>');
    }
    delBtn.classList.remove('hidden');
    document.getElementById('job-name').value      = job.name        ?? '';
    sel.value                                       = job.printerId;
    if (!isQueued && job.start) {
      startVal = toDatetimeLocal(new Date(job.start));
      endVal   = toDatetimeLocal(new Date(job.end));
    }
    setStartVal(startVal);
    document.getElementById('job-customer').value  = job.customerName ?? '';
    document.getElementById('job-ordernr').value   = job.orderNr      ?? '';
    document.getElementById('job-colors').value    = job.colors       ?? '';
    document.getElementById('job-printfile').value = job.printFile    ?? '';
    document.getElementById('job-bedtype').value   = job.bedType      ?? '';
    // Populate color editor
    document.getElementById('job-colors-editor').innerHTML = renderColorEditor(parseColorsField(job.colors));
    // Show thumbnail if available
    const thumbGroup = document.getElementById('job-thumb-group');
    if (job.thumbFile) {
      document.getElementById('job-thumb-img').src = `/api/uploads/${job.thumbFile}`;
      thumbGroup.style.display = '';
    } else { thumbGroup.style.display = 'none'; }
    // Show download link if printFile is an uploaded file
    const pfDisplay = document.getElementById('job-printfile-display');
    const hasRetained3mf = job.printFile && !job.printFile.includes('/') && job.printFile.endsWith('.3mf');
    if (job.printFile && !job.printFile.includes('/')) {
      const dlName = `${job.orderNr ? job.orderNr + '_' : ''}${job.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.3mf`;
      pfDisplay.innerHTML = `<a href="/api/uploads/${escHtml(job.printFile)}" download="${escHtml(dlName)}" style="color:var(--primary);font-size:13px">📦 ${escHtml(dlName)}</a>`;
      document.getElementById('job-printfile').style.display = 'none';
    } else {
      pfDisplay.innerHTML = '';
      document.getElementById('job-printfile').style.display = '';
    }
    // "Herlaad items uit 3MF" only makes sense when a retained .3mf is on file.
    document.getElementById('btn-reload-items-3mf').classList.toggle('hidden', !hasRetained3mf);
    document.getElementById('job-items').value      = job.items != null ? job.items : '';
    document.getElementById('job-items-lost').value = job.items_lost ?? 0;
    document.getElementById('job-remarks').value   = job.remarks      ?? '';
    document.getElementById('job-cooldown').value  = job.cool_down_mins ?? '';
    document.getElementById('job-warmup').value    = job.warm_up_mins ?? '';
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
    setStartVal(startVal);
    setEndVal(endVal);
    document.getElementById('job-customer').value  = prefill.customerName ?? '';
    document.getElementById('job-ordernr').value   = prefill.orderNr      ?? '';
    document.getElementById('job-colors').value    = prefill.colors       ?? '';
    document.getElementById('job-colors-editor').innerHTML = renderColorEditor(parseColorsField(prefill.colors));
    document.getElementById('job-printfile').value = prefill.printFile    ?? '';
    document.getElementById('job-bedtype').value   = prefill.bedType      ?? '';
    document.getElementById('job-printfile').style.display = '';
    document.getElementById('job-printfile-display').innerHTML = '';
    document.getElementById('job-thumb-group').style.display = 'none';
    document.getElementById('btn-reload-items-3mf').classList.add('hidden');
    document.getElementById('job-items').value      = prefill.items != null ? prefill.items : '';
    document.getElementById('job-items-lost').value = prefill.items_lost ?? 0;
    document.getElementById('job-remarks').value   = prefill.remarks      ?? '';
    // Leave blank on create → server snapshots the printer's warm-up/cool-down.
    document.getElementById('job-cooldown').value  = prefill.cool_down_mins ?? '';
    document.getElementById('job-warmup').value    = prefill.warm_up_mins ?? '';
    editingJobStatus = prefill.status ?? 'Planned';
    setQueuedMode(isQueued);
    // Populate queue duration fields from prefill
    const dur = prefill.durationMins ?? 0;
    if (dur > 0) {
      document.getElementById('job-queue-dur-h').value = Math.floor(dur / 60);
      document.getElementById('job-queue-dur-m').value = dur % 60;
    }
  }

  // Populate customer suggestions from past jobs
  const allJobs   = await api('GET', '/api/jobs');
  const customers = [...new Set(allJobs.map(j => j.customerName).filter(n => n?.trim()))];
  document.getElementById('customer-suggestions').innerHTML =
    customers.map(c => `<option value="${escHtml(c)}">`).join('');

  // Populate project suggestions (datalist) + prefill the current job's project.
  await loadProjectSuggestions();
  const projInput = document.getElementById('job-project');
  if (projInput) {
    if (jobId !== null) {
      const job = allJobs.find(j => j.id === jobId);
      projInput.value = job?.project_id ? (projectsById[job.project_id]?.label ?? job.project_id) : '';
    } else {
      projInput.value = prefill.project ?? '';
    }
  }

  // Always open in duration mode; derive h/m from start+end when available
  setEndMode('duration', startVal, endVal);

  // Override schedule duration from prefill.durationMins (after setEndMode which may reset to 1h default)
  if (!editJobId && prefill.durationMins > 0) {
    document.getElementById('job-duration-h').value = Math.floor(prefill.durationMins / 60);
    document.getElementById('job-duration-m').value = prefill.durationMins % 60;
  }

  document.getElementById('job-modal').classList.remove('hidden');
  if (scheduleMode) document.getElementById('job-start-date').focus();
  else document.getElementById('job-name').focus();
}

async function saveJob() {
  const wasEditing   = editJobId !== null;
  const isQueued     = document.getElementById('job-queued').checked;
  const name         = document.getElementById('job-name').value.trim();
  const printerId    = parseInt(document.getElementById('job-printer').value);
  const customerName = document.getElementById('job-customer').value.trim();
  const orderNr      = document.getElementById('job-ordernr').value.trim();
  const colors       = collectJobColors() || document.getElementById('job-colors').value.trim();
  const printFile    = document.getElementById('job-printfile').value.trim();
  const bedType      = document.getElementById('job-bedtype').value || null;
  const remarks      = document.getElementById('job-remarks').value.trim();
  const project      = document.getElementById('job-project').value.trim();
  const status       = editingJobStatus;
  // Blank cool-down → omit so the server keeps the snapshot (or takes a fresh
  // one from the printer on create). A number is a manual per-job override.
  const cooldownRaw  = document.getElementById('job-cooldown').value.trim();
  const coolDownMins = cooldownRaw === '' ? null : (parseInt(cooldownRaw, 10) || 0);
  const warmupRaw    = document.getElementById('job-warmup').value.trim();
  const warmUpMins   = warmupRaw === '' ? null : (parseInt(warmupRaw, 10) || 0);
  // Items: blank = untracked (null). Items lost: blank = 0. Both must be
  // non-negative integers; losses may not exceed items when items is tracked
  // (reject rather than clamp — the user should see and fix a wrong number).
  const itemsRaw     = document.getElementById('job-items').value.trim();
  const itemsLostRaw = document.getElementById('job-items-lost').value.trim();
  const items        = itemsRaw === '' ? null : parseInt(itemsRaw, 10);
  const itemsLost    = itemsLostRaw === '' ? 0 : parseInt(itemsLostRaw, 10);

  if (!name)      return alert('Please enter a job name.');
  if (!printerId) return alert('Please select a printer.');
  if (items != null && (!Number.isInteger(items) || items < 0)) return alert('Items moet een positief geheel getal zijn (of leeg voor niet-bijgehouden).');
  if (!Number.isInteger(itemsLost) || itemsLost < 0) return alert('Verlies moet een positief geheel getal zijn.');
  if (items != null && itemsLost > items) return alert('Verlies kan niet groter zijn dan het aantal items.');

  if (isQueued) {
    const qh = parseInt(document.getElementById('job-queue-dur-h').value) || 0;
    const qm = parseInt(document.getElementById('job-queue-dur-m').value) || 0;
    if (qh === 0 && qm === 0) return alert('Please enter an expected duration.');
    const durationMins = qh * 60 + qm;
    const data = { printerId, name, customerName, orderNr, colors, printFile, bedType, remarks, status, queued: true, durationMins, project, items, items_lost: itemsLost };
    if (coolDownMins != null) data.cool_down_mins = coolDownMins;
    if (warmUpMins != null) data.warm_up_mins = warmUpMins;
    if (wasEditing) await api('PUT', `/api/jobs/${editJobId}`, data);
    else            await api('POST', '/api/jobs', data);
    closeModal('job-modal');
    renderCalendar();
    return;
  }

  const start = getStartVal();
  if (!start) return alert('Please set a start time.');

  let end;
  const durationMode = !document.getElementById('end-duration-row').classList.contains('hidden');
  if (durationMode) {
    const h = parseInt(document.getElementById('job-duration-h').value) || 0;
    const m = parseInt(document.getElementById('job-duration-m').value) || 0;
    if (h === 0 && m === 0) return alert('Please enter a duration greater than 0.');
    end = toDatetimeLocal(new Date(new Date(start).getTime() + (h * 60 + m) * 60_000));
  } else {
    end = getEndVal();
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

  const data = { printerId, name, customerName, orderNr, colors, printFile, bedType, remarks, start, end, status, queued: false, project, items, items_lost: itemsLost };
  if (coolDownMins != null) data.cool_down_mins = coolDownMins;
  if (warmUpMins != null) data.warm_up_mins = warmUpMins;
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
    if (scr) scr.scrollTop = Math.max(0, minToPx(jobStart.getHours() * 60 + jobStart.getMinutes()) - 120);
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
  await renderConnectedAccounts();
  document.getElementById('printers-modal').classList.remove('hidden');
}

async function renderConnectedAccounts() {
  const config = await api('GET', '/api/brands/bambulab/config').catch(() => null);
  bambuAccountEmail = config?.connected ? (config.email || null) : null;
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
    if (config?.email)   document.getElementById('bambu-email').value  = config.email;
    if (config?.region)  document.getElementById('bambu-region').value = config.region;
  }
}

async function openPrinterDialog(id) {
  // Populate colour swatches
  const swatches = document.getElementById('color-swatches');
  swatches.innerHTML = PRESET_COLORS.map(c =>
    `<div class="color-swatch" style="background:${c}" data-color="${c}" title="${c}"></div>`
  ).join('');
  swatches.querySelectorAll('.color-swatch').forEach(s =>
    s.addEventListener('click', () => { document.getElementById('printer-color').value = s.dataset.color; })
  );

  if (id) {
    editPrinter(id);
  } else {
    resetPrinterForm();
  }
  document.getElementById('printer-dialog').classList.remove('hidden');
  document.getElementById('printer-name').focus();
}

async function refreshPrinterList() {
  printers = await api('GET', '/api/printers');
  const list = document.getElementById('printers-list');
  if (!printers.length) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;margin-bottom:4px">No printers yet.</p>';
    return;
  }
  const pinnedCount = printers.filter(p => p.pinned).length;
  list.innerHTML = printers.map(p => {
    const bambuIcon = (p.brand === 'bambulab' && p.bambu_serial && bambuAccountEmail)
      ? `<span class="bambu-linked-icon" title="Connected to BambuLab account (${escHtml(bambuAccountEmail)})">🌐</span>`
      : '';
    return `
    <div class="printer-item">
      <div class="printer-color-dot" style="background:${p.color}"></div>
      <span class="printer-item-name">${escHtml(p.name)}${printerStatusPillHtml(p)}${bambuIcon}</span>
      <div class="printer-item-actions">
        <button class="btn-icon fav-btn${p.favourite ? ' fav-active' : ''}" onclick="togglePrinterFavourite(${p.id}, ${p.favourite ? 0 : 1})" title="${p.favourite ? 'Hide in day view' : 'Show in day view'}">👁</button>
        <button class="btn-icon pin-btn${p.pinned ? ' pinned' : ''}" onclick="togglePrinterPinned(${p.id}, ${p.pinned ? 0 : 1})" title="${p.pinned ? 'Unpin from topbar' : (pinnedCount >= topbarLimit ? `Max ${topbarLimit} pinned` : 'Pin to topbar')}">⭐</button>
        <button class="btn-icon" onclick="openPrinterDialog(${p.id})" title="Edit">✏️</button>
        <button class="btn-icon danger" onclick="deletePrinter(${p.id})" title="Delete">🗑</button>
      </div>
    </div>`;
  }).join('');
}

async function togglePrinterFavourite(id, newVal) {
  const p = printers.find(x => x.id === id);
  if (!p) return;
  await api('PUT', `/api/printers/${id}`, { ...p, favourite: newVal });
  await refreshPrinterList();
  renderCalendar();
}

async function togglePrinterPinned(id, newVal) {
  const p = printers.find(x => x.id === id);
  if (!p) return;
  if (newVal === 1 && printers.filter(x => x.pinned).length >= topbarLimit) {
    const hint = document.getElementById('printers-list');
    const msg = document.createElement('p');
    msg.style.cssText = 'color:var(--danger);font-size:12px;margin:4px 0 0';
    msg.textContent = `Max ${topbarLimit} printers can be pinned. Unpin one first.`;
    hint.prepend(msg);
    setTimeout(() => msg.remove(), 3000);
    return;
  }
  await api('PUT', `/api/printers/${id}`, { ...p, pinned: newVal });
  await refreshPrinterList();
  _lastTopbarIds = null; // force chip rebuild
  renderTopbarStatus();
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
  document.getElementById('printer-warm-up').value      = '5';
  document.getElementById('printer-cool-down').value    = '15';
  document.getElementById('printer-favourite').checked  = true;
  setBrand('bambulab');
  document.getElementById('printer-dialog-title').textContent = 'Add Printer';
  document.getElementById('btn-save-printer').textContent     = 'Add Printer';
}

function editPrinter(id) {
  const p = printers.find(pr => pr.id === id);
  if (!p) return;
  editPrintId = id;
  document.getElementById('printer-name').value         = p.name;
  document.getElementById('printer-color').value        = p.color;
  document.getElementById('printer-bambu-serial').value = p.bambu_serial || '';
  document.getElementById('printer-favourite').checked  = !!p.favourite;
  const knownBrands = ['bambulab', 'prusa', 'creality', 'klipper', 'octoprint'];
  const brand = p.brand || 'other';
  if (knownBrands.includes(brand)) {
    setBrand(brand);
  } else {
    setBrand('other');
    document.getElementById('printer-brand-other').value = brand;
  }
  document.getElementById('printer-warm-up').value      = p.warm_up_mins  ?? 5;
  document.getElementById('printer-cool-down').value    = p.cool_down_mins ?? 15;
  document.getElementById('printer-dialog-title').textContent = 'Edit Printer';
  document.getElementById('btn-save-printer').textContent     = 'Save Changes';
  // Show BambuLab account status in dialog
  const statusEl = document.getElementById('printer-bambu-account-status');
  if (statusEl) {
    if (p.brand === 'bambulab' && bambuAccountEmail) {
      statusEl.textContent = `🌐 Connected to BambuLab account: ${bambuAccountEmail}`;
      statusEl.style.color = 'var(--success, #22c55e)';
    } else if (p.brand === 'bambulab') {
      statusEl.textContent = 'No BambuLab account connected. Add one in "Connected Accounts".';
      statusEl.style.color = 'var(--text-muted)';
    } else {
      statusEl.textContent = '';
    }
  }
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
  const warm_up_mins   = parseInt(document.getElementById('printer-warm-up').value,  10) || 0;
  const cool_down_mins = parseInt(document.getElementById('printer-cool-down').value, 10) || 0;
  const favourite      = document.getElementById('printer-favourite').checked ? 1 : 0;
  if (!name) return alert('Please enter a printer name.');

  const pinned = editPrintId !== null ? (printers.find(p => p.id === editPrintId)?.pinned ?? 0) : 0;
  if (editPrintId !== null) {
    await api('PUT', `/api/printers/${editPrintId}`, { name, color, brand, bambu_serial, pinned, warm_up_mins, cool_down_mins, favourite });
  } else {
    await api('POST', '/api/printers', { name, color, brand, bambu_serial, pinned: 0, warm_up_mins, cool_down_mins, favourite });
  }

  document.getElementById('printer-dialog').classList.add('hidden');
  await refreshPrinterList();
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
// Push notifications
// =============================================================================
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
}

// True for iPhone/iPad (incl. iPadOS, which lies about its UA).
function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) ||
         (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
// True when the page is running as an installed PWA from the Home Screen.
function isStandalonePWA() {
  return navigator.standalone === true ||
         window.matchMedia('(display-mode: standalone)').matches;
}

function renderPushSubscribeSection() {
  const section = document.getElementById('push-subscribe-section');
  const prefs   = document.getElementById('push-prefs-section');
  if (!section) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    // iOS Safari pre-16.4 OR iOS Safari NOT installed as a PWA — both lack
    // PushManager. Show install instructions instead of a blanket "not supported".
    if (isIOS() && !isStandalonePWA()) {
      section.innerHTML = `
        <div style="font-size:13px;color:var(--text-muted);line-height:1.5;border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--bg)">
          <strong style="color:var(--text);display:block;margin-bottom:6px">📱 Install on iPhone first</strong>
          On iOS, push notifications are only available when the app is installed to your Home Screen.
          <ol style="margin:8px 0 0 18px;padding:0">
            <li>Tap the Share button <span style="font-family:'apple-system',sans-serif">⎙</span> in Safari's toolbar</li>
            <li>Choose <strong>Add to Home Screen</strong></li>
            <li>Open <strong>PrintFarm</strong> from your Home Screen</li>
            <li>Come back to this Settings panel and tap <em>Enable</em></li>
          </ol>
        </div>`;
      if (prefs) prefs.classList.add('hidden');
      return;
    }
    section.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">Push notifications are not supported by this browser.</p>';
    if (prefs) prefs.classList.add('hidden');
    return;
  }
  if (Notification.permission === 'denied') {
    section.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">Push notifications blocked by browser. Allow them in browser settings.</p>';
    if (prefs) prefs.classList.add('hidden');
    return;
  }
  if (pushSubscribed) {
    section.innerHTML = '<div style="display:flex;align-items:center;gap:10px"><span style="font-size:13px;color:var(--success,#22c55e)">● Enabled</span><button type="button" id="btn-push-unsubscribe" class="btn btn-secondary btn-sm">Disable</button></div>';
    document.getElementById('btn-push-unsubscribe').addEventListener('click', unsubscribePush);
    if (prefs) prefs.classList.remove('hidden');
  } else {
    section.innerHTML = '<button type="button" id="btn-push-subscribe" class="btn btn-secondary">Enable Push Notifications</button>';
    document.getElementById('btn-push-subscribe').addEventListener('click', subscribePush);
    if (prefs) prefs.classList.add('hidden');
  }
}

async function checkPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    pushSubscribed = !!sub;
  } catch { pushSubscribed = false; }
}

async function subscribePush() {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { renderPushSubscribeSection(); return; }
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('GET', '/api/push/public-key');
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await api('POST', '/api/push/subscribe', sub.toJSON());
    pushSubscribed = true;
    renderPushSubscribeSection();
  } catch (e) {
    alert('Could not enable push notifications: ' + (e.message || e));
  }
}

async function unsubscribePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('DELETE', '/api/push/unsubscribe', sub.toJSON());
      await sub.unsubscribe();
    }
    pushSubscribed = false;
    renderPushSubscribeSection();
  } catch (e) {
    alert('Could not disable push notifications: ' + (e.message || e));
  }
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
  ['Planned', 'Printing', 'Post Printing', 'Done', 'Awaiting'].forEach(status => {
    const inp = document.getElementById('sc-' + status.replace(/\s+/g, '-'));
    if (inp) inp.value = statusMeta[status]?.color ?? '#888888';
  });

  const qae = await api('GET', '/api/settings/queueAutoExpand');
  const cb = document.getElementById('setting-queue-auto-expand');
  if (cb) cb.checked = qae?.value === true;

  const tm = await api('GET', '/api/settings/topbarMode');
  const tmRadio = document.querySelector(`input[name="topbar-mode"][value="${tm?.value ?? 'pinned'}"]`);
  if (tmRadio) tmRadio.checked = true;

  // Push notification settings
  await checkPushSubscription();
  renderPushSubscribeSection();
  const pnd = await api('GET', '/api/settings/push.notify.done').catch(() => null);
  const pns = await api('GET', '/api/settings/push.notify.started').catch(() => null);
  const pnu = await api('GET', '/api/settings/push.notify.upcoming').catch(() => null);
  const pnp = await api('GET', '/api/settings/push.notify.paused').catch(() => null);
  const pnc = await api('GET', '/api/settings/push.notify.conflict').catch(() => null);
  const pnpr = await api('GET', '/api/settings/push.notify.project').catch(() => null);
  const cbDone     = document.getElementById('push-notify-done');
  const cbStarted  = document.getElementById('push-notify-started');
  const cbUpcoming = document.getElementById('push-notify-upcoming');
  const cbPaused   = document.getElementById('push-notify-paused');
  const cbConflict = document.getElementById('push-notify-conflict');
  const cbProject  = document.getElementById('push-notify-project');
  if (cbDone)     cbDone.checked     = pnd?.value !== false;
  if (cbStarted)  cbStarted.checked  = pns?.value !== false;
  if (cbUpcoming) cbUpcoming.checked = pnu?.value !== false;
  if (cbPaused)   cbPaused.checked   = pnp?.value !== false;
  if (cbConflict) cbConflict.checked = pnc?.value !== false;
  if (cbProject)  cbProject.checked  = pnpr?.value !== false;

  // Load scheduling restrictions
  const schedRestr = await api('GET', '/api/settings/schedulingRestrictions');
  const sr = schedRestr?.value || {};
  const tzSel = document.getElementById('setting-timezone');
  if (tzSel && !tzSel.options.length) {
    let zones;
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = null; }
    if (!zones || !zones.length) {
      zones = ['UTC','Europe/Brussels','Europe/Amsterdam','Europe/Paris','Europe/Berlin','Europe/London','Europe/Madrid','America/New_York','America/Los_Angeles','Asia/Tokyo'];
    }
    for (const z of zones) {
      const opt = document.createElement('option');
      opt.value = z; opt.textContent = z;
      tzSel.appendChild(opt);
    }
  }
  if (tzSel) tzSel.value = sr.timezone || 'Europe/Brussels';
  document.getElementById('setting-silent-start').value = sr.silentStart || '21:00';
  document.getElementById('setting-silent-end').value = sr.silentEnd || '06:30';
  document.querySelectorAll('.sched-closed-day').forEach(cb => {
    cb.checked = (sr.closedDays || []).includes(parseInt(cb.value));
  });

  document.getElementById('settings-modal').classList.remove('hidden');

  // Load connected apps
  loadConnectedApps();
}

async function loadConnectedApps() {
  const el = document.getElementById('connected-apps-panel');
  if (!el) return;
  try {
    const data = await api('GET', '/api/discover');
    const config = await api('GET', '/api/config');
    let html = '';

    if (!config.sharedAuth) {
      html = `<div style="padding:12px;background:var(--warning-tint);border:1px solid var(--warning);border-radius:6px;margin-bottom:12px">
        <strong>Shared auth not configured</strong>
        <p style="font-size:13px;color:var(--text-muted);margin-top:4px">Set <code>SHARED_AUTH_SECRET</code> in your .env file to enable SSO and app discovery.</p>
      </div>`;
    } else {
      html = `<div style="padding:8px 12px;background:var(--success-tint);border:1px solid var(--success);border-radius:6px;margin-bottom:12px;font-size:13px">Shared authentication is <strong>enabled</strong></div>`;
    }
    const appIcons = { calculator: '\ud83e\uddee', filament: '\ud83e\uddf5', planner: '\ud83d\udcc5' };
    const fallbackNames = { calculator: '3D Project Calculator', filament: 'Filament Manager', planner: 'PrintFarm Planner' };
    const keys = Object.keys(data.apps || {});
    if (!keys.length) {
      html += '<p style="color:var(--text-muted)">No sibling app URLs configured. Set <code>CALCULATOR_URL</code>, <code>FILAMENT_URL</code> in .env.</p>';
    } else {
      for (const k of keys) {
        const a = data.apps[k];
        const dot = a.available ? '\ud83d\udfe2' : '\ud83d\udd34';
        const icon = appIcons[k] || '\ud83d\udce6';
        const name = a.appName || fallbackNames[k] || k;
        const info = a.available ? `v${a.version || '?'}` : 'Unreachable';
        const displayUrl = a.publicUrl || a.url || '';
        html += `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div style="font-weight:600">${dot} ${icon} ${escHtml(name)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${escHtml(info)}${displayUrl ? ` \u2014 <a href="${escHtml(displayUrl)}" target="_blank" style="color:var(--primary)">${escHtml(displayUrl)}</a>` : ''}</div>
        </div>`;
      }
    }
    el.innerHTML = html;
  } catch { el.innerHTML = '<span style="color:var(--danger)">Failed to load</span>'; }
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
      await renderConnectedAccounts();
      await refreshPrinterList();
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
      await renderConnectedAccounts();
      await refreshPrinterList();
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
  await renderConnectedAccounts();
  await refreshPrinterList();
}

// Auto-save individual settings on change (no Save button needed)
async function autoSave(key, value) {
  await api('PUT', `/api/settings/${key}`, { value });
}

function setupSettingsAutoSave() {
  const q = s => document.getElementById(s);
  const qa = s => document.querySelectorAll(s);

  q('setting-theme')?.addEventListener('change', async function() { await autoSave('theme', this.value); applyTheme(this.value); });
  qa('input[name="default-view"]').forEach(r => r.addEventListener('change', () => autoSave('defaultView', r.value)));
  q('setting-queue-auto-expand')?.addEventListener('change', function() { autoSave('queueAutoExpand', this.checked); });

  // Status colors — any change saves all colors
  ['Planned', 'Printing', 'Post Printing', 'Done', 'Awaiting'].forEach(status => {
    q('sc-' + status.replace(/\s+/g, '-'))?.addEventListener('change', async () => {
      const c = {};
      ['Planned', 'Printing', 'Post Printing', 'Done', 'Awaiting'].forEach(s => { const el = q('sc-' + s.replace(/\s+/g, '-')); if (el) c[s] = el.value; });
      await autoSave('statusColors', c);
      await loadStatusColors();
      renderCalendar();
    });
  });

  // Topbar mode
  qa('input[name="topbar-mode"]').forEach(r => r.addEventListener('change', async () => {
    await autoSave('topbarMode', r.value); topbarModeCache = r.value; _lastTopbarIds = null; renderTopbarStatus();
  }));

  // Push notifications
  ['push-notify-done', 'push-notify-started', 'push-notify-upcoming', 'push-notify-paused', 'push-notify-conflict', 'push-notify-project'].forEach(id => {
    q(id)?.addEventListener('change', function() { autoSave('push.notify.' + id.replace('push-notify-', ''), this.checked); });
  });
  q('btn-test-push')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-push');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await api('POST', '/api/push/test');
      btn.textContent = '✓ Sent';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    } catch (e) {
      btn.textContent = '✗ Failed';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
      alert('Failed to send test push: ' + (e.message || e));
    }
  });

  // Silent schedule — any change saves all restrictions
  const saveSilent = () => {
    const closedDays = []; qa('.sched-closed-day:checked').forEach(cb => closedDays.push(parseInt(cb.value)));
    autoSave('schedulingRestrictions', {
      enabled: true,
      timezone: q('setting-timezone')?.value || 'Europe/Brussels',
      silentStart: q('setting-silent-start')?.value || '21:00',
      silentEnd: q('setting-silent-end')?.value || '06:30',
      closedDays,
    });
  };
  q('setting-timezone')?.addEventListener('change', saveSilent);
  q('setting-silent-start')?.addEventListener('change', saveSilent);
  q('setting-silent-end')?.addEventListener('change', saveSilent);
  qa('.sched-closed-day').forEach(cb => cb.addEventListener('change', saveSilent));
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
  syncUrlToState();
  renderCalendar();
}

// =============================================================================
// Go to job (navigate to day view, scroll + highlight the job block)
// =============================================================================
async function goToJob(jobId) {
  let job = jobsCache[jobId];
  if (!job) {
    job = await api('GET', `/api/jobs/${jobId}`);
    if (!job) return;
    jobsCache[jobId] = job;
  }
  if (!job.start) return; // queued — no date

  view = 'day';
  navDate = new Date(job.start);
  navDate.setHours(0, 0, 0, 0);

  // On mobile (single-printer-column view) switch the active tab to this job's
  // printer so the job is actually visible after renderCalendar.
  if (job.printerId != null) setMobilePrinterByPrinterId(job.printerId);

  syncUrlToState();
  await renderCalendar();

  setTimeout(() => {
    const el = document.querySelector(`.job-block[data-job-id="${jobId}"]`);
    if (!el) return;
    const scr = document.getElementById('day-scroll');
    if (scr) scr.scrollTop = Math.max(0, (parseInt(el.style.top) || 0) - 120);
    el.classList.add('job-block-highlight');
    setTimeout(() => el.classList.remove('job-block-highlight'), 2000);
  }, 80);
}

// Go to a printer (switch to day view on its day-view column / mobile tab).
// Used by printer-level notifications (started, done, paused).
async function goToPrinter(printerId) {
  view = 'day';
  setMobilePrinterByPrinterId(printerId);
  syncUrlToState();
  await renderCalendar();
}

// Set the mobile printer switcher to the index that matches this printerId.
// No-op on desktop — mobilePrinterIdx is only consulted in single-column layout.
function setMobilePrinterByPrinterId(printerId) {
  const visible = printers.filter(p => p.favourite);
  const idx = visible.findIndex(p => p.id === printerId);
  if (idx >= 0) mobilePrinterIdx = idx;
}

// Deep-link handler for hash navigation. Hash shapes:
//   #day/YYYY-MM-DD       → day view on the given date
//   #week/YYYY-MM-DD      → week view containing the given date
//   #month/YYYY-MM-DD     → month view containing the given date
//   #upcoming/YYYY-MM-DD  → upcoming view anchored at the given date
//   #printer/<id>         → day view today with the given printer tab active
//   #job/<id>             → day view on the given job's day, printer + highlight
// Any other hash (or no hash) is ignored.
function handleDeepLink(urlOrHash) {
  try {
    const raw = typeof urlOrHash === 'string' ? urlOrHash : '';
    const hash = raw.includes('#') ? raw.slice(raw.indexOf('#')) : raw;
    // Job / printer one-shot deep links (from push notifications).
    const idm = /^#(printer|job)\/(\d+)/.exec(hash);
    if (idm) {
      if (idm[1] === 'job') goToJob(parseInt(idm[2], 10));
      else                  goToPrinter(parseInt(idm[2], 10));
      return true;
    }
    // Stateful view + date restoration (back/forward/refresh).
    const vm = /^#(day|week|month|upcoming)\/(\d{4})-(\d{2})-(\d{2})$/.exec(hash);
    if (vm) {
      const newView = vm[1];
      const y = parseInt(vm[2], 10);
      const mo = parseInt(vm[3], 10);
      const d = parseInt(vm[4], 10);
      const parsed = new Date(y, mo - 1, d);
      if (isNaN(parsed.getTime())) return false;
      view = newView;
      navDate = parsed;
      const today = todayMidnight();
      const isToday = parsed.getFullYear() === today.getFullYear() &&
                      parsed.getMonth()    === today.getMonth()    &&
                      parsed.getDate()     === today.getDate();
      if (view === 'day' && isToday) pendingScrollToNow = true;
      renderCalendar();
      return true;
    }
    return false;
  } catch { return false; }
}

// Compose the hash that represents the current view + nav date, and push it
// onto the history stack (or replace, depending on caller). Kept idempotent —
// if the target hash is already current, nothing happens so we don't fill
// history with duplicates.
function syncUrlToState({ replace = false } = {}) {
  const p = n => String(n).padStart(2, '0');
  const d = navDate;
  const hash = `#${view}/${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (location.hash === hash) return;
  const url = location.pathname + location.search + hash;
  try {
    if (replace) history.replaceState(null, '', url);
    else         history.pushState(null, '', url);
  } catch { /* ignore */ }
}

// =============================================================================
// Status overview modal
// =============================================================================

// Dialog category order — 'Paused' sits directly after 'Printing'. (The
// context menu that sets a status deliberately omits 'Paused' — it is a
// system-only status; see #ctx-menu / .bs-status-btn in index.html.)
const SO_STATUS_ORDER   = ['Planned', 'Awaiting', 'Awaiting Printer', 'Printing', 'Paused', 'Post Printing', 'Done'];
const SO_EXPAND_DEFAULT = ['Awaiting Printer', 'Printing', 'Paused', 'Awaiting', 'Post Printing'];
// Persisted set of collapsed sections so a live re-render keeps the user's
// expand/collapse choices. null until the overview is first opened.
let soCollapsed = null;

// Count shown on the "Job Status" menu entry: jobs needing attention =
// (Post Printing) + (Paused). Refreshed live from renderCalendar().
function updateStatusOverviewBadge() {
  const badge = document.getElementById('status-overview-badge');
  if (!badge) return;
  // Shared pure count (public/statusCount.js) — same logic the test exercises.
  const count = countAttentionJobs(Object.values(jobsCache));
  if (count > 0) {
    badge.textContent = String(count);
    badge.classList.remove('hidden');
  } else {
    badge.textContent = '';
    badge.classList.add('hidden');
  }
}

// Render the overview body from the current jobsCache + printers. Called on
// open and re-called live whenever a job status changes while it is open.
function renderStatusOverviewBody() {
  const body = document.getElementById('status-overview-body');
  if (!body) return;
  const scheduled = Object.values(jobsCache).filter(j => !j.queued);
  renderStatusGroups(body, scheduled, soCollapsed);
}

// Shared status-grouped renderer used by BOTH the Job Status Overview and the
// project detail view. Groups `jobList` by status into SO_STATUS_ORDER sections
// with per-section counts + job rows, honouring `collapsed` (a Set of collapsed
// status names). Left-click a row -> jump to the job; right-click -> status menu.
function renderStatusGroups(body, jobList, collapsed) {
  if (!body) return;

  const printerMap = Object.fromEntries(printers.map(p => [p.id, p]));
  const scheduled = jobList;

  const p2 = n => String(n).padStart(2, '0');
  const fmtDateTime = d => {
    const dt = new Date(d);
    return `${fmtDate(dt,'D MMM')} ${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
  };

  let h = '';
  SO_STATUS_ORDER.forEach(status => {
    const group = scheduled
      .filter(j => (j.status ?? 'Planned') === status)
      .sort((a, b) => new Date(b.start) - new Date(a.start));

    const expanded = !collapsed.has(status);
    h += `<div class="so-section">
      <div class="so-section-header" data-so-status="${escHtml(status)}">
        <span class="job-status-badge" style="${statusBadgeStyle(status)}">${escHtml(status)}</span>
        <span style="color:var(--text-muted);font-weight:400">${group.length}</span>
        <span class="so-section-toggle">${expanded ? '▲' : '▼'}</span>
      </div>
      <div class="so-section-body${expanded ? '' : ' hidden'}">`;

    if (group.length === 0) {
      h += `<div class="so-empty">No jobs.</div>`;
    } else {
      group.forEach(job => {
        const printer = printerMap[job.printerId];
        const orderLabel = job.orderNr ? `#${escHtml(job.orderNr)}` : '—';
        const customerLabel = job.customerName ? escHtml(job.customerName) : '—';
        const printerLabel  = printer ? escHtml(printer.name) : '—';
        const dateLabel = job.start ? fmtDateTime(job.start) : '—';
        const linkIcon  = job.linked_printer_id ? ' 🔗' : '';
        h += `<div class="so-row" data-job-id="${job.id}">
          <span class="so-row-ordernr">${orderLabel}</span>
          <span class="so-row-name">${escHtml(job.name)}${linkIcon}</span>
          <span class="so-row-customer">${customerLabel}</span>
          <span class="so-row-printer">${printerLabel}</span>
          <span class="so-row-date">${dateLabel}</span>
        </div>`;
      });
    }
    h += `</div></div>`;
  });

  body.innerHTML = h;

  // Collapsible toggle — persist state in soCollapsed so re-renders keep it.
  body.querySelectorAll('.so-section-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const status = hdr.dataset.soStatus;
      const sectionBody = hdr.nextElementSibling;
      const toggle = hdr.querySelector('.so-section-toggle');
      const isHidden = sectionBody.classList.toggle('hidden');
      toggle.textContent = isHidden ? '▼' : '▲';
      if (isHidden) collapsed.add(status); else collapsed.delete(status);
    });
  });

  // Left-click row → jump to job in day calendar.
  // Right-click row → status context menu (reuses #ctx-menu / showCtxMenu).
  body.querySelectorAll('.so-row[data-job-id]').forEach(row => {
    row.addEventListener('click', () => {
      closeModal('status-overview-modal');
      goToJob(parseInt(row.dataset.jobId));
    });
    row.addEventListener('contextmenu', e => showCtxMenu(e, parseInt(row.dataset.jobId)));
  });
}

// Re-render the overview in place if it is currently open (after a live
// status change), keeping expand/collapse state intact.
function refreshStatusOverviewIfOpen() {
  const modal = document.getElementById('status-overview-modal');
  if (modal && !modal.classList.contains('hidden')) renderStatusOverviewBody();
}

async function openStatusOverview() {
  const [allJobs, allPrinters] = await Promise.all([
    api('GET', '/api/jobs'),
    api('GET', '/api/printers'),
  ]);
  rebuildJobsCache(allJobs);
  printers = allPrinters;
  if (soCollapsed === null) {
    soCollapsed = new Set(SO_STATUS_ORDER.filter(s => !SO_EXPAND_DEFAULT.includes(s)));
  }
  renderStatusOverviewBody();
  document.getElementById('status-overview-modal').classList.remove('hidden');
}

// =============================================================================
// Projects
// =============================================================================
// id -> { id, label, status, ... } cache, refreshed whenever we fetch the list.
let projectsById = {};
let pdProjectId = null;                 // project id shown in the detail modal
let pdCollapsed = null;                 // per-status collapsed set for the detail view

// Fetch the sorted project summaries and refresh the id->label cache.
async function fetchProjects() {
  const list = await api('GET', '/api/projects');
  projectsById = Object.fromEntries(list.map(p => [p.id, p]));
  return list;
}

// Populate the #project-suggestions datalist (used by the +job / edit field).
async function loadProjectSuggestions() {
  const list = await fetchProjects().catch(() => []);
  const dl = document.getElementById('project-suggestions');
  if (dl) dl.innerHTML = list.map(p => `<option value="${escHtml(p.label)}">`).join('');
}

// Compact per-project counter: "jobs 5/12  ● 1 bezig" (done/total + busy badge),
// plus an optional items line "items 3/8 ● 2 bezig · 1 verlies" in the same
// visual style. The items line renders only when the project tracks items
// (itemsTotal > 0); losses are already subtracted from both figures server-side.
function projectCounterHtml(p) {
  const busyBadge = p.busy > 0
    ? ` <span class="project-busy-badge">● ${p.busy} bezig</span>`
    : '';
  const jobLine = `<span class="project-counter-line"><span class="project-counter">jobs ${p.done}/${p.total}</span>${busyBadge}</span>`;
  let itemsLine = '';
  if (p.itemsTotal > 0) {
    const itemsBusy = p.itemsBusy > 0
      ? ` <span class="project-busy-badge">● ${p.itemsBusy} bezig</span>`
      : '';
    const lost = p.itemsLost > 0
      ? ` <span class="project-items-lost">· ${p.itemsLost} verlies</span>`
      : '';
    itemsLine = `<span class="project-counter-line project-items-line"><span class="project-items-counter">items ${p.itemsDoneAdj}/${p.itemsTotalAdj}</span>${itemsBusy}${lost}</span>`;
  }
  return `${jobLine}${itemsLine}`;
}

async function openProjectsModal() {
  const list = await fetchProjects();
  const body = document.getElementById('projects-body');
  if (list.length === 0) {
    body.innerHTML = `<div class="so-empty">Nog geen projecten.</div>`;
  } else {
    body.innerHTML = list.map(p => {
      const closed = p.status === 'closed';
      const closedTag = closed ? ` <span class="project-closed-tag">gesloten</span>` : '';
      return `<div class="project-row${closed ? ' project-row-closed' : ''}" data-project-id="${escHtml(p.id)}">
        <span class="project-row-label">${escHtml(p.label)}${closedTag}</span>
        <span class="project-row-counter">${projectCounterHtml(p)}</span>
      </div>`;
    }).join('');
    body.querySelectorAll('.project-row[data-project-id]').forEach(row => {
      row.addEventListener('click', () => openProjectDetail(row.dataset.projectId));
    });
  }
  document.getElementById('projects-modal').classList.remove('hidden');
}

// Re-fetch + re-render the Projecten list in place when it is open, so the
// per-project counters stay live after a job status/project change.
async function refreshProjectsModalIfOpen() {
  const modal = document.getElementById('projects-modal');
  if (modal && !modal.classList.contains('hidden')) await openProjectsModal();
}

// Single entry point after any context-menu / bottom-sheet job mutation that can
// affect a project's view (status change, project reassign, project clear):
// refresh whichever project modal is currently open. Each refresh is gated to
// its own modal being open, so nothing renders that the user isn't looking at.
async function refreshOpenProjectViews() {
  await refreshProjectDetailIfOpen();
  await refreshProjectsModalIfOpen();
}

async function openProjectDetail(projectId) {
  const data = await api('GET', `/api/projects/${encodeURIComponent(projectId)}`);
  if (!data) return;
  pdProjectId = data.project.id;
  // Reuse the same expand-default as the status overview.
  pdCollapsed = new Set(SO_STATUS_ORDER.filter(s => !SO_EXPAND_DEFAULT.includes(s)));
  renderProjectDetail(data);
  document.getElementById('project-detail-modal').classList.remove('hidden');
}

// Render the project-detail body + footer controls from a GET /api/projects/:id
// payload. Shared by the open path and the in-place refresh path (keeps the
// current pdCollapsed expand/collapse state intact). printers is already
// populated by the app boot / overview.
function renderProjectDetail(data) {
  const closed = data.project.status === 'closed';
  const jobs = data.jobs.filter(j => !j.queued);
  const title = document.getElementById('project-detail-title');
  title.textContent = data.project.label + (closed ? ' (gesloten)' : '');
  // The detail view reuses the Job Status Overview rendering, filtered to this
  // project's jobs.
  renderStatusGroups(document.getElementById('project-detail-body'), jobs, pdCollapsed);
  // Hide the "Close project" control for an already-closed project.
  document.getElementById('btn-close-project').classList.toggle('hidden', closed);
  // "Verwijder project" only for a truly EMPTY project: gate on the UNFILTERED
  // job count so it matches deleteIfEmpty's all-jobs guard (queued jobs still
  // hold a project_id and block the delete). `jobs` stays filtered for display.
  document.getElementById('btn-delete-project').classList.toggle('hidden', data.jobs.length > 0);
}

// Re-fetch + re-render the project-detail modal in place when it is the open
// context, so a job whose status/project changed via the context menu updates
// (moves bucket, drops out on reassign/clear) without a close+reopen.
async function refreshProjectDetailIfOpen() {
  const modal = document.getElementById('project-detail-modal');
  if (!modal || modal.classList.contains('hidden') || pdProjectId === null) return;
  const data = await api('GET', `/api/projects/${encodeURIComponent(pdProjectId)}`);
  if (!data) return;
  renderProjectDetail(data);
}

async function deleteCurrentProject() {
  if (!pdProjectId) return;
  if (!confirm('Dit lege project verwijderen? Dit kan niet ongedaan gemaakt worden.')) return;
  try {
    await api('DELETE', `/api/projects/${encodeURIComponent(pdProjectId)}`);
    closeModal('project-detail-modal');
    openProjectsModal();
  } catch (err) {
    let msg = err.message;
    try { msg = JSON.parse(err.message).error || msg; } catch { /* raw */ }
    alert(msg);
  }
}

async function closeCurrentProject() {
  if (!pdProjectId) return;
  if (!confirm('Dit project sluiten? Het zakt naar onder in de lijst.')) return;
  await api('POST', `/api/projects/${encodeURIComponent(pdProjectId)}/close`);
  closeModal('project-detail-modal');
  openProjectsModal();
}

// Context-menu "Assign to project": picker of EXISTING projects only.
async function openAssignProject(jobId) {
  const list = await fetchProjects();
  const open = list.filter(p => p.status !== 'closed');
  const sel = document.getElementById('assign-project-select');
  if (open.length === 0) {
    alert('Nog geen projecten om aan toe te wijzen. Maak er eerst een via +Job.');
    return;
  }
  const noneOpt = `<option value="__none__">Geen project</option>`;
  sel.innerHTML = noneOpt + open.map(p => `<option value="${escHtml(p.id)}">${escHtml(p.label)}</option>`).join('');
  sel.dataset.jobId = String(jobId);
  // Preselect the job's current project (falls back to "Geen project" when the
  // job has none, or when its project is closed and thus not in the open list).
  const current = jobsCache[jobId]?.project_id;
  sel.value = current || '__none__';
  document.getElementById('assign-project-modal').classList.remove('hidden');
}

async function confirmAssignProject() {
  const sel = document.getElementById('assign-project-select');
  const jobId = parseInt(sel.dataset.jobId);
  const projectId = sel.value;
  if (!jobId || !projectId) return;
  try {
    await api('POST', `/api/jobs/${jobId}/assign-project`, { projectId });
    closeModal('assign-project-modal');
    await renderCalendar();
    await refreshOpenProjectViews();
  } catch (err) {
    let msg = err.message;
    try { msg = JSON.parse(err.message).error || msg; } catch { /* raw */ }
    alert(msg);
  }
}

// =============================================================================
// Event listeners
// =============================================================================
function setupListeners() {
  // Refresh all data when the tab comes back to the foreground
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onPageVisible();
  });

  // Clicking the date label opens the native date picker
  document.getElementById('date-label').addEventListener('click', () => {
    const inp = document.getElementById('date-jump');
    inp.value = toDateKey(navDate);
    inp.showPicker();
  });
  document.getElementById('date-jump').addEventListener('change', e => {
    if (!e.target.value) return;
    navDate = new Date(e.target.value + 'T00:00:00');
    syncUrlToState();
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
        const scr = document.getElementById('day-scroll');
        const savedScroll = scr ? scr.scrollTop : 0;
        await api('PATCH', `/api/jobs/${ctxJobId}`, { status: btn.dataset.status });
        await renderCalendar();
        refreshStatusOverviewIfOpen();
        await refreshOpenProjectViews();
        const scr2 = document.getElementById('day-scroll');
        if (scr2) scr2.scrollTop = savedScroll;
      }
      hideCtxMenu();
    });
  });
  document.getElementById('ctx-assign-project').addEventListener('click', () => {
    const id = ctxJobId;
    hideCtxMenu();
    if (id !== null) openAssignProject(id);
  });
  document.getElementById('ctx-duplicate').addEventListener('click', () => {
    if (ctxJobId !== null) duplicateJob(ctxJobId);
    hideCtxMenu();
  });
  document.getElementById('ctx-push-now').addEventListener('click', async () => {
    const id = ctxJobId;
    hideCtxMenu();
    if (id !== null) await pushBackJob(id, null);
  });
  document.getElementById('ctx-push-to').addEventListener('click', () => {
    const id = ctxJobId;
    hideCtxMenu();
    if (id !== null) openPushBackModal(id);
  });
  document.getElementById('ctx-pull-now').addEventListener('click', async () => {
    const id = ctxJobId;
    hideCtxMenu();
    if (id !== null) await pullForwardJob(id, null, null);
  });
  document.getElementById('ctx-pull-to').addEventListener('click', () => {
    const id = ctxJobId;
    hideCtxMenu();
    if (id !== null) openPullForwardModal(id);
  });

  // Push-back modal
  document.getElementById('pushback-cancel').addEventListener('click', closePushBackModal);
  document.getElementById('pushback-confirm').addEventListener('click', async () => {
    const val = document.getElementById('pushback-datetime').value;
    const id = _pushBackJobId;
    if (!val || id == null) return closePushBackModal();
    closePushBackModal();
    await pushBackJob(id, val);
  });

  // Pull-forward modal
  document.getElementById('pullforward-cancel').addEventListener('click', closePullForwardModal);
  document.getElementById('pullforward-window-toggle').addEventListener('change', (e) => {
    document.getElementById('pullforward-window-row').classList.toggle('hidden', !e.target.checked);
  });
  document.getElementById('pullforward-confirm').addEventListener('click', async () => {
    const startVal = document.getElementById('pullforward-datetime').value;
    const useWindow = document.getElementById('pullforward-window-toggle').checked;
    const endVal   = useWindow ? document.getElementById('pullforward-window-end').value : null;
    const moveChain = document.getElementById('pullforward-chain-toggle').checked;
    const id = _pullForwardJobId;
    if (!startVal || id == null) return closePullForwardModal();
    closePullForwardModal();
    // No end time → force the exact start (verbatim + reshuffle). End time → window fit.
    await pullForwardJob(id, startVal, endVal || null, moveChain);
  });

  // Reshove confirm modal
  document.getElementById('reshove-cancel').addEventListener('click', () => closeReshoveModal(false));
  document.getElementById('reshove-confirm').addEventListener('click', () => closeReshoveModal(true));

  // Queue item context menu
  document.getElementById('qctx-earliest').addEventListener('click', async () => {
    const id = queueCtxJobId; hideQueueCtxMenu();
    if (id !== null) await scheduleQueueJob(id, 'earliest');
  });
  document.getElementById('qctx-now').addEventListener('click', async () => {
    const id = queueCtxJobId; hideQueueCtxMenu();
    if (id !== null) await scheduleQueueJob(id, 'at', null); // to=null → server "now"
  });
  document.getElementById('qctx-at').addEventListener('click', () => {
    const id = queueCtxJobId; hideQueueCtxMenu();
    if (id !== null) openQueueAtModal(id);
  });
  document.getElementById('queue-at-cancel').addEventListener('click', closeQueueAtModal);
  document.getElementById('queue-at-confirm').addEventListener('click', async () => {
    const val = document.getElementById('queue-at-datetime').value;
    const id = _queueAtJobId;
    if (!val || id == null) return closeQueueAtModal();
    closeQueueAtModal();
    await scheduleQueueJob(id, 'at', val);
  });

  // Conflict resolution
  document.getElementById('ctx-move-after').addEventListener('click', async () => {
    const id = ctxJobId;
    hideCtxMenu();
    if (id !== null) await resolveConflictMoveAfter(id);
  });
  document.getElementById('ctx-move-next-day').addEventListener('click', async () => {
    const id = ctxJobId;
    hideCtxMenu();
    if (id !== null) await resolveConflictNextDay(id);
  });
  document.getElementById('ctx-move-printer').addEventListener('click', async () => {
    const id = ctxJobId;
    hideCtxMenu();
    if (id !== null) await resolveConflictMovePrinter(id);
  });
  document.getElementById('ctx-delete').addEventListener('click', async () => {
    if (ctxJobId !== null && confirm('Delete this print job?')) {
      await api('DELETE', `/api/jobs/${ctxJobId}`);
      renderCalendar();
    }
    hideCtxMenu();
  });
  // Link / unlink
  document.getElementById('ctx-link-item').addEventListener('click', async () => {
    if (ctxJobId === null) return;
    const action = document.getElementById('ctx-link-item').dataset.action;
    const id = ctxJobId;
    hideCtxMenu();
    await applyLinkAction(id, action);
    renderCalendar();
  });
  // Lock / unlock
  document.getElementById('ctx-lock-item').addEventListener('click', async () => {
    if (ctxJobId === null) return;
    const action = document.getElementById('ctx-lock-item').dataset.action;
    const id = ctxJobId;
    hideCtxMenu();
    await applyLockAction(id, action);
    renderCalendar();
  });

  // Click linked-job chip in topbar popup or status panel → jump to that job
  document.getElementById('printer-status-bar').addEventListener('click', e => {
    const el = e.target.closest('.spopup-linked-job[data-job-id]');
    if (el) goToJob(parseInt(el.dataset.jobId));
  });
  document.getElementById('printer-status-panel').addEventListener('click', e => {
    const el = e.target.closest('.spopup-linked-job[data-job-id]');
    if (el) {
      document.getElementById('printer-status-panel').classList.add('hidden');
      document.getElementById('btn-printer-status').setAttribute('aria-expanded', 'false');
      goToJob(parseInt(el.dataset.jobId));
    }
  });
  document.addEventListener('click',       () => { hideCtxMenu(); hideQueueCtxMenu(); });
  document.addEventListener('contextmenu', e => {
    // Hide if right-clicking outside a job element
    if (!e.target.closest('[data-job-id]')) hideCtxMenu();
    // Hide the queue menu unless the right-click is on a queue item
    if (!e.target.closest('.queue-item')) hideQueueCtxMenu();
  });

  // Drag events (document-level so mouse/touch can leave the column)
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup',   onDragEnd);
  document.addEventListener('touchmove', onTouchDragMove, { passive: false });
  document.addEventListener('touchend',  onTouchDragEnd);

  // Bottom sheet (mobile context menu)
  setupBottomSheet();

  // Re-render on resize (mobile ↔ desktop layout switch)
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderCalendar(), 250);
  });

  document.getElementById('btn-prev').addEventListener('click',  () => navigate(-1));
  document.getElementById('btn-next').addEventListener('click',  () => navigate(+1));
  document.getElementById('btn-today').addEventListener('click', () => {
    navDate = todayMidnight();
    if (view === 'day') pendingScrollToNow = true;
    syncUrlToState();
    renderCalendar();
  });

  ['day','week','month','upcoming'].forEach(v => {
    document.getElementById(`btn-${v}`).addEventListener('click', () => {
      view = v;
      if (v === 'day') pendingScrollToNow = true;
      syncUrlToState();
      renderCalendar();
    });
  });

  // Browser back/forward: restore view + navDate from the hash.
  window.addEventListener('popstate', () => {
    handleDeepLink(location.hash);
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

  document.getElementById('btn-projects').addEventListener('click', openProjectsModal);
  document.getElementById('btn-close-project').addEventListener('click', closeCurrentProject);
  document.getElementById('btn-delete-project').addEventListener('click', deleteCurrentProject);
  document.getElementById('btn-assign-project').addEventListener('click', confirmAssignProject);

  document.getElementById('job-queued').addEventListener('change', e => {
    setQueuedMode(e.target.checked);
  });
  document.getElementById('btn-topbar-menu').addEventListener('click', e => { e.stopPropagation(); toggleTopbarMenu(); });
  document.getElementById('topbar-menu').addEventListener('click', () => {
    document.getElementById('topbar-menu').classList.remove('open');
    document.getElementById('btn-topbar-menu').setAttribute('aria-expanded', 'false');
  });
  document.getElementById('btn-manage-printers').addEventListener('click', openPrintersModal);
  document.getElementById('btn-manage-closures').addEventListener('click', openClosuresModal);
  document.getElementById('btn-status-overview').addEventListener('click', openStatusOverview);
  document.getElementById('btn-save-closure').addEventListener('click', saveClosure);
  document.getElementById('btn-cancel-closure').addEventListener('click', resetClosureForm);
  document.getElementById('btn-printer-status').addEventListener('click', toggleStatusPanel);
  document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
  setupSettingsAutoSave();

  // Settings tab switching
  document.getElementById('planner-settings-tabs')?.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const panel = tab.dataset.stab;
    document.querySelectorAll('#planner-settings-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.stab === panel));
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== panel));
    // Load connected apps lazily
    if (panel === 'apps') loadConnectedApps();
  });
  document.getElementById('btn-bambu-connect').addEventListener('click', bambuConnect);
  document.getElementById('btn-bambu-verify').addEventListener('click', bambuVerify);
  document.getElementById('btn-bambu-disconnect').addEventListener('click', bambuDisconnect);
  document.getElementById('btn-bambu-cancel-verify').addEventListener('click', renderConnectedAccounts);
  document.getElementById('btn-export').addEventListener('click', exportData);
  document.getElementById('btn-import-trigger').addEventListener('click', () =>
    document.getElementById('import-file').click()
  );
  document.getElementById('import-file').addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  document.getElementById('btn-save-job').addEventListener('click',    saveJob);
  document.getElementById('btn-reload-items-3mf').addEventListener('click', reloadItemsFrom3mf);
  document.getElementById('btn-delete-job').addEventListener('click',  deleteJob);
  document.getElementById('btn-save-printer').addEventListener('click',  savePrinter);
  document.getElementById('btn-add-printer').addEventListener('click', () => openPrinterDialog(null));
  document.getElementById('brand-picker').addEventListener('click', e => {
    const btn = e.target.closest('.brand-btn');
    if (btn) setBrand(btn.dataset.brand);
  });


  // Duration ↔ end-date toggle
  document.getElementById('toggle-duration').addEventListener('click', () => {
    setEndMode('duration', getStartVal(), getEndVal());
  });
  document.getElementById('toggle-enddate').addEventListener('click', () => {
    // Compute end from current start + duration, then switch to end-date mode
    const start = getStartVal();
    const h = parseInt(document.getElementById('job-duration-h').value) || 0;
    const m = parseInt(document.getElementById('job-duration-m').value) || 0;
    if (start && (h > 0 || m > 0)) {
      setEndVal(toDatetimeLocal(new Date(new Date(start).getTime() + (h * 60 + m) * 60_000)));
    }
    setEndMode('enddate', start, getEndVal());
  });

  // Close buttons
  document.querySelectorAll('[data-close]').forEach(btn =>
    btn.addEventListener('click', () => closeModal(btn.dataset.close))
  );
  // Click overlay to close
  document.querySelectorAll('.modal-overlay').forEach(overlay =>
    overlay.addEventListener('click', e => {
      if (e.target !== overlay) return;
      // The reshove confirm modal backs a pending Promise — route its dismissal
      // through closeReshoveModal so the Promise resolves (false) instead of
      // hanging forever.
      if (overlay.id === 'reshove-modal') closeReshoveModal(false);
      else closeModal(overlay.id);
    })
  );

  // Escape closes any open modal or context menu
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // Lightbox sits on top of the job modal — dismiss it first, leave the modal open.
    const lb = document.getElementById('img-lightbox');
    if (lb && lb.style.display !== 'none') { closeImgLightbox(); return; }
    hideCtxMenu();
    if (!document.getElementById('pushback-modal').classList.contains('hidden')) closePushBackModal();
    if (!document.getElementById('pullforward-modal').classList.contains('hidden')) closePullForwardModal();
    if (!document.getElementById('reshove-modal').classList.contains('hidden')) closeReshoveModal(false);
    ['job-modal', 'printers-modal', 'printer-dialog', 'closures-modal', 'settings-modal', 'status-overview-modal'].forEach(id => {
      if (!document.getElementById(id).classList.contains('hidden')) closeModal(id);
    });
  });
}

// =============================================================================
// 3MF Import for Scheduling
// =============================================================================
let import3mfParsed = null;
let import3mfBuffer = null;
let import3mfBusy = false;
let import3mfDefaultDate = null;
let import3mfFilename = null;
let import3mfPlateOrder = []; // current display order of original plate indices

// Pure helper: swap an entry with its neighbour and return a new array.
// direction: -1 = up, +1 = down. No-op (returns a fresh copy of `order`)
// when the move would cross the array boundary.
function reorderPlates(order, fromIdx, direction) {
  const next = order.slice();
  const target = fromIdx + direction;
  if (target < 0 || target >= next.length) return next;
  [next[fromIdx], next[target]] = [next[target], next[fromIdx]];
  return next;
}

function initImport3mf() {
  document.getElementById('btn-import-3mf')?.addEventListener('click', () => {
    document.getElementById('topbar-menu')?.classList.remove('open');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.3mf';
    input.onchange = () => start3mfImport(input.files?.[0]);
    input.click();
  });

  document.getElementById('btn-import3mf-save')?.addEventListener('click', confirm3mfSchedule);

  // Drag & drop 3MF onto the calendar
  const calContainer = document.getElementById('calendar-container');
  if (calContainer) {
    calContainer.addEventListener('dragover', e => {
      if (Array.from(e.dataTransfer?.items || []).some(i => i.kind === 'file')) {
        e.preventDefault();
        calContainer.classList.add('cal-drop-active');
      }
    });
    calContainer.addEventListener('dragleave', e => {
      if (!calContainer.contains(e.relatedTarget)) calContainer.classList.remove('cal-drop-active');
    });
    calContainer.addEventListener('drop', e => {
      calContainer.classList.remove('cal-drop-active');
      const file = Array.from(e.dataTransfer?.files || []).find(f => f.name.toLowerCase().endsWith('.3mf'));
      if (file) {
        e.preventDefault();
        // Pre-set the start date to the current navDate
        // Use navDate but never earlier than today
        const today = new Date(); today.setHours(0,0,0,0);
        const nd = navDate ? new Date(navDate) : today;
        import3mfDefaultDate = nd < today ? today : nd;
        start3mfImport(file);
      }
    });
  }
}

async function start3mfImport(file) {
  if (!file || import3mfBusy) return;
  import3mfBusy = true;
  import3mfFilename = file.name;

  // Show progress
  document.getElementById('import3mf-title').textContent = 'Importing 3MF...';
  document.getElementById('import3mf-body').innerHTML = `
    <div style="text-align:center;padding:24px">
      <p>${escHtml(file.name)} (${(file.size / 1048576).toFixed(1)} MB)</p>
      <div style="width:100%;height:8px;background:var(--border);border-radius:4px;margin:12px 0">
        <div id="import3mf-progress" style="height:100%;width:0%;background:var(--primary);border-radius:4px;transition:width .15s"></div>
      </div>
      <span id="import3mf-status" style="color:var(--text-muted);font-size:13px">Uploading... 0%</span>
    </div>`;
  document.getElementById('btn-import3mf-save').style.display = 'none';
  document.getElementById('import3mf-modal').classList.remove('hidden');

  const fileBuffer = await file.arrayBuffer();
  import3mfBuffer = { name: file.name, buffer: fileBuffer };

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/parse-3mf');
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');

  xhr.upload.addEventListener('progress', e => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    const bar = document.getElementById('import3mf-progress');
    const label = document.getElementById('import3mf-status');
    if (bar) bar.style.width = pct + '%';
    if (label) label.textContent = pct < 100 ? `Uploading... ${pct}%` : 'Parsing...';
  });

  xhr.addEventListener('load', () => {
    import3mfBusy = false;
    document.getElementById('btn-import3mf-save').style.display = '';
    let parsed;
    try { parsed = JSON.parse(xhr.responseText); } catch { alert('Failed to parse response'); closeModal('import3mf-modal'); return; }
    if (xhr.status >= 400) { alert('Error: ' + (parsed.error || '')); closeModal('import3mf-modal'); return; }
    if (!parsed.plates?.length) { alert('No plates found in this 3MF file.'); closeModal('import3mf-modal'); return; }
    if (!parsed.sliced) { alert('This 3MF is not sliced. Please slice it first.'); closeModal('import3mf-modal'); return; }
    import3mfParsed = parsed;
    show3mfSchedulePreview(parsed, file.name);
  });

  xhr.addEventListener('error', () => {
    import3mfBusy = false;
    alert('Upload failed');
    closeModal('import3mf-modal');
  });

  xhr.send(file);
}

function show3mfSchedulePreview(parsed, filename) {
  const printerLabel = parsed.printerName ? ` (${parsed.printerName})` : '';
  const fnLabel = import3mfFilename ? ` — ${import3mfFilename}` : '';
  document.getElementById('import3mf-title').textContent = `Schedule from 3MF${fnLabel}${printerLabel} — ${parsed.plates.length} plate${parsed.plates.length > 1 ? 's' : ''}`;

  // Fuzzy match printer name
  const norm = s => s.toLowerCase().replace(/[\s\-_]+/g, '').replace('lab', '');
  let matchedPrinterId = '';
  if (parsed.printerName) {
    const pNorm = norm(parsed.printerName);
    const match = printers.find(pr => { const n = norm(pr.name); return pNorm.includes(n) || n.includes(pNorm); });
    if (match) matchedPrinterId = match.id;
  }
  const matchedPrinter = printers.find(pr => pr.id == matchedPrinterId);
  const matchedPrinterLabel = matchedPrinter
    ? escHtml(matchedPrinter.name)
    : (parsed.printerName ? `${escHtml(parsed.printerName)} — no farm match, pick per plate` : 'None matched — pick per plate');

  import3mfDefaultDate = null; // reset (drag-in date no longer used in queue mode)
  const totalMins = parsed.plates.reduce((s, pl) => s + (pl.printTimeMinutes || 0), 0);

  // Reset display order for this dialog (identity).
  import3mfPlateOrder = parsed.plates.map((_, i) => i);

  // Render a single plate row given the original plate index `i` and its
  // visible position `pos` (used to disable boundary arrows).
  function renderPlateRow(i, pos, total) {
    const pl = parsed.plates[i];
    const thumb = parsed.thumbnails?.[pl.index];
    const nameDefault = pl.plateName || pl.objects?.join(', ') || `Plate ${pl.index}`;
    const typeInfo = pl.filamentType || '';
    const colorDots = (pl.filaments || []).map(f =>
      f.color ? `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${f.color};border:1px solid rgba(0,0,0,.15);vertical-align:middle" title="${ntc.name(f.color)?.[1] || f.color}"></span>` : ''
    ).join(' ');
    const upDisabled = pos === 0;
    const downDisabled = pos === total - 1;
    const arrowBtn = (dir, disabled) => `<button type="button" data-sched-move="${i}" data-sched-dir="${dir}" ${disabled ? 'disabled' : ''} title="Move ${dir === -1 ? 'up' : 'down'}" style="background:none;border:1px solid var(--border);border-radius:3px;padding:0 6px;font-size:13px;line-height:1.4;cursor:${disabled ? 'not-allowed' : 'pointer'};opacity:${disabled ? '0.35' : '1'}">${dir === -1 ? '▲' : '▼'}</button>`;

    return `<div data-sched-row="${i}" style="display:flex;gap:12px;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:6px">
      ${thumb ? `<img src="${thumb}" style="width:64px;height:64px;object-fit:cover;border-radius:4px;border:1px solid var(--border);flex-shrink:0" alt="">` : ''}
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" checked data-sched-check="${i}" style="width:auto"> <strong>Plate ${pl.index}</strong></label>
          <span style="color:var(--text-muted);font-size:12px">${typeInfo}${pl.bedType ? ` / ${formatBedType(pl.bedType)}` : ''}</span>
          ${colorDots}
          <span style="margin-left:auto;display:inline-flex;gap:4px">${arrowBtn(-1, upDisabled)}${arrowBtn(1, downDisabled)}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:13px">
          <div><label style="font-size:11px;color:var(--text-muted)">Name</label><input type="text" value="${escHtml(nameDefault)}" data-sched-name="${i}" style="width:100%;padding:4px 8px;font-size:13px"></div>
          <div><label style="font-size:11px;color:var(--text-muted)">Duration</label><div style="font-weight:600;padding:4px 0">${Math.floor(pl.printTimeMinutes / 60)}h ${Math.round(pl.printTimeMinutes % 60)}m</div></div>
          <div><label style="font-size:11px;color:var(--text-muted)">Plastic</label><div style="padding:4px 0">${(pl.weightGrams || 0).toFixed(1)}g</div></div>
          <div><label style="font-size:11px;color:var(--text-muted)">Objects</label><div style="padding:4px 0">${pl.objectCount || pl.objects?.length || 1}</div></div>
          <div style="grid-column:1/-1"><label style="font-size:11px;color:var(--text-muted)">Printer</label><select data-sched-printer="${i}" style="width:100%;padding:4px 8px;font-size:13px">
            <option value="">-- Select --</option>
            ${printers.map(pr => `<option value="${pr.id}" ${pr.id == matchedPrinterId ? 'selected' : ''}>${escHtml(pr.name)}</option>`).join('')}
          </select></div>
          <div><label style="font-size:11px;color:var(--text-muted)">Customer</label><input type="text" value="" data-sched-customer="${i}" style="width:100%;padding:4px 8px;font-size:13px" placeholder="Optional"></div>
          <div><label style="font-size:11px;color:var(--text-muted)">Order #</label><input type="text" value="" data-sched-ordernr="${i}" style="width:100%;padding:4px 8px;font-size:13px" placeholder="Optional"></div>
        </div>
      </div>
    </div>`;
  }

  function renderRowsHtml() {
    return import3mfPlateOrder.map((i, pos) => renderPlateRow(i, pos, import3mfPlateOrder.length)).join('');
  }

  // Snapshot/restore field values keyed on original plate index so reorder
  // never wipes typed-in customer name / order # / printer / name / checkbox.
  function snapshotFieldValues() {
    const snap = {};
    for (const i of import3mfPlateOrder) {
      const get = sel => document.querySelector(sel);
      snap[i] = {
        name:     get(`[data-sched-name="${i}"]`)?.value,
        printer:  get(`[data-sched-printer="${i}"]`)?.value,
        customer: get(`[data-sched-customer="${i}"]`)?.value,
        ordernr:  get(`[data-sched-ordernr="${i}"]`)?.value,
        checked:  get(`[data-sched-check="${i}"]`)?.checked,
      };
    }
    return snap;
  }

  function applyFieldValues(snap) {
    for (const i of Object.keys(snap)) {
      const v = snap[i];
      const setVal = (sel, val) => { const el = document.querySelector(sel); if (el != null && val !== undefined) el.value = val; };
      const setChk = (sel, val) => { const el = document.querySelector(sel); if (el != null && val !== undefined) el.checked = val; };
      setVal(`[data-sched-name="${i}"]`, v.name);
      setVal(`[data-sched-printer="${i}"]`, v.printer);
      setVal(`[data-sched-customer="${i}"]`, v.customer);
      setVal(`[data-sched-ordernr="${i}"]`, v.ordernr);
      setChk(`[data-sched-check="${i}"]`, v.checked);
    }
  }

  document.getElementById('import3mf-body').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
          <div style="font-size:13px;color:var(--text-muted)">Target printer: <strong style="color:var(--text)">${matchedPrinterLabel}</strong></div>
          <div style="flex:1;text-align:right;font-size:13px;color:var(--text-muted)" id="sched-total-label">Total: ${Math.floor(totalMins / 60)}h ${Math.round(totalMins % 60)}m across ${parsed.plates.length} plate${parsed.plates.length > 1 ? 's' : ''}</div>
        </div>
        <div style="font-size:13px;color:var(--text-muted);padding:6px 0 0">
          Jobs are added to the queue (no fixed start time). Set the printer per plate below.
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;font-size:12px;padding:0">
        <a href="#" id="sched-toggle-all" style="color:var(--primary);text-decoration:none">Deselect all</a>
      </div>
      <div id="sched-rows">${renderRowsHtml()}</div>
    </div>`;

  function recomputeTotal() {
    let mins = 0, count = 0;
    parsed.plates.forEach((pl, i) => {
      const checked = document.querySelector(`[data-sched-check="${i}"]`)?.checked;
      if (checked) { mins += pl.printTimeMinutes || 0; count++; }
    });
    const label = document.getElementById('sched-total-label');
    if (label) label.textContent = `Total: ${Math.floor(mins/60)}h ${Math.round(mins%60)}m across ${count} plate${count !== 1 ? 's' : ''}`;
  }

  function refreshToggleAllLabel() {
    const link = document.getElementById('sched-toggle-all');
    if (!link) return;
    const anyChecked = Array.from(document.querySelectorAll('[data-sched-check]')).some(cb => cb.checked);
    link.textContent = anyChecked ? 'Deselect all' : 'Select all';
  }

  function attachRowListeners() {
    // Per-checkbox: total + toggle-all label.
    document.querySelectorAll('[data-sched-check]').forEach(cb => {
      cb.addEventListener('change', () => { recomputeTotal(); refreshToggleAllLabel(); });
    });
    // Per-arrow: snapshot, swap, re-render rows region, restore, rewire.
    document.querySelectorAll('[data-sched-move]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const origIdx = parseInt(btn.getAttribute('data-sched-move'), 10);
        const dir = parseInt(btn.getAttribute('data-sched-dir'), 10);
        const pos = import3mfPlateOrder.indexOf(origIdx);
        if (pos < 0) return;
        const snap = snapshotFieldValues();
        import3mfPlateOrder = reorderPlates(import3mfPlateOrder, pos, dir);
        document.getElementById('sched-rows').innerHTML = renderRowsHtml();
        applyFieldValues(snap);
        attachRowListeners();
        refreshToggleAllLabel();
      });
    });
  }

  setTimeout(() => {
    // Select all / Deselect all link
    document.getElementById('sched-toggle-all')?.addEventListener('click', e => {
      e.preventDefault();
      const checks = Array.from(document.querySelectorAll('[data-sched-check]'));
      const anyChecked = checks.some(cb => cb.checked);
      const target = !anyChecked; // if none checked → check all; else uncheck all
      checks.forEach(cb => {
        if (cb.checked !== target) {
          cb.checked = target;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      refreshToggleAllLabel();
    });

    attachRowListeners();
  }, 0);
}

async function confirm3mfSchedule() {
  if (!import3mfParsed) return;
  const btn = document.getElementById('btn-import3mf-save');
  btn.disabled = true;
  btn.textContent = 'Adding...';

  try {
    // Best-effort: try to enrich color names from the filament-manager catalog.
    // Falls back to ntc names if filament-manager is unreachable.
    const filamentCatalog = await fetchFilamentCatalog().catch(() => []);

    const plates = import3mfPlateOrder.map(i => {
      const pl = import3mfParsed.plates[i];
      const check = document.querySelector(`[data-sched-check="${i}"]`);
      if (check && !check.checked) return null;
      const isDual = pl.isDualExtruder || (pl.nozzleCount || 1) >= 2;
      const colors = (pl.filaments || []).map(f => {
        const profile = import3mfParsed.filamentProfiles?.[f.id - 1];
        const hex   = f.color || '#888888';
        const brand = profile?.vendor && profile.vendor !== 'Generic' ? profile.vendor : '';
        const fmMatch = matchFilamentInCatalog({ color: hex, brand, type: f.type }, filamentCatalog);
        return {
          color: hex,
          name: fmMatch?.colorName
                || (typeof ntc !== 'undefined' ? ntc.name(hex)?.[1] : '')
                || hex,
          brand: fmMatch?.brand || brand,
          extruder: isDual && f.extruder ? (f.extruder === 1 ? 'L' : 'R') : null,
        };
      });

      return {
        plateIndex: pl.index,
        name: document.querySelector(`[data-sched-name="${i}"]`)?.value || `Plate ${pl.index}`,
        printerId: parseInt(document.querySelector(`[data-sched-printer="${i}"]`)?.value) || null,
        customerName: document.querySelector(`[data-sched-customer="${i}"]`)?.value || null,
        orderNr: document.querySelector(`[data-sched-ordernr="${i}"]`)?.value || null,
        durationMins: Math.round(pl.printTimeMinutes || 0),
        bedType: pl.bedType || null,
        items: Number.isInteger(pl.objectCount) ? pl.objectCount : (pl.objects?.length ?? null),
        colors,
      };
    });

    const selectedPlates = plates.filter(Boolean);
    if (!selectedPlates.length) { alert('No plates selected'); return; }

    const res = await fetch('/api/import-3mf-schedule', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Schedule': encodeURIComponent(JSON.stringify({ plates: selectedPlates, mode: 'queue' })),
      },
      body: import3mfBuffer.buffer,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Failed: ' + (err.error || res.statusText));
      return;
    }

    closeModal('import3mf-modal');
    import3mfParsed = null;
    import3mfBuffer = null;

    // Reload and render
    await renderCalendar();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add to Queue';
  }
}

// =============================================================================
// Attach 3MF to existing job
// =============================================================================
let attachJobId = null;
let attach3mfBuffer = null;
let attach3mfParsed = null;

// "Herlaad items uit 3MF": re-parse the job's retained 3MF and set its item
// count from the plate. Single plate → apply directly. Multiple → let the user
// pick which plate (by name) this job maps to. Persists via PATCH immediately.
async function reloadItemsFrom3mf() {
  if (!editJobId) return;
  const jobId = editJobId;
  let plates;
  try {
    plates = await api('GET', `/api/jobs/${jobId}/3mf-plates`);
  } catch {
    alert('Kon het 3MF-bestand niet lezen.');
    return;
  }
  if (!Array.isArray(plates) || plates.length === 0) {
    alert('Geen geldig 3MF-bestand gevonden voor deze job.');
    return;
  }
  if (plates.length === 1) {
    await applyReloadedPlate(jobId, plates[0]);
    return;
  }
  // Multiple plates → name picker (reuses the import modal shell).
  closeModal('job-modal');
  document.getElementById('import3mf-title').textContent = 'Kies plate voor items';
  const rows = plates.map((pl, i) => {
    const label = pl.name || `Plate ${i + 1}`;
    const h = Math.floor((pl.durationMins || 0) / 60), m = (pl.durationMins || 0) % 60;
    return `<div class="attach-plate-option" data-reload-plate="${i}" style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;cursor:pointer">
      <strong>${escHtml(label)}</strong>
      <span style="color:var(--text-muted);font-size:13px">${pl.objectCount} items · ${h}h ${m}m</span>
    </div>`;
  }).join('');
  document.getElementById('import3mf-body').innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">${rows}</div>`;
  document.getElementById('btn-import3mf-save').style.display = 'none';
  document.getElementById('import3mf-modal').classList.remove('hidden');
  document.querySelectorAll('#import3mf-body [data-reload-plate]').forEach(el => {
    el.addEventListener('click', async () => {
      const idx = parseInt(el.dataset.reloadPlate, 10);
      await applyReloadedPlate(jobId, plates[idx]);
      closeModal('import3mf-modal');
    });
  });
}

async function applyReloadedPlate(jobId, plate) {
  const items = Number.isInteger(plate.objectCount) ? plate.objectCount : null;
  await api('PATCH', `/api/jobs/${jobId}`, { items, plate_name: plate.name ?? null });
  // Reflect in the still-open edit dialog (single-plate path keeps it open).
  const itemsInput = document.getElementById('job-items');
  if (itemsInput && editJobId === jobId) itemsInput.value = items != null ? items : '';
  await renderCalendar();
}

function initAttach3mf() {
  document.getElementById('attach-3mf-input')?.addEventListener('change', async function() {
    const file = this.files?.[0];
    if (!file || !editJobId) return;
    this.value = '';
    attachJobId = editJobId;
    attach3mfBuffer = await file.arrayBuffer();

    // Close job modal, show import modal with progress
    closeModal('job-modal');
    document.getElementById('import3mf-title').textContent = 'Attaching 3MF...';
    document.getElementById('import3mf-body').innerHTML = `<div style="text-align:center;padding:24px"><p>Parsing ${escHtml(file.name)}...</p></div>`;
    document.getElementById('btn-import3mf-save').style.display = 'none';
    document.getElementById('import3mf-modal').classList.remove('hidden');

    const parseRes = await fetch('/api/parse-3mf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: attach3mfBuffer,
    });
    if (!parseRes.ok) { alert('Failed to parse 3MF'); closeModal('import3mf-modal'); return; }
    attach3mfParsed = await parseRes.json();
    if (!attach3mfParsed.sliced || !attach3mfParsed.plates?.length) {
      alert('3MF must be sliced'); closeModal('import3mf-modal'); return;
    }

    showAttachPlatePreview();
  });
}

function showAttachPlatePreview() {
  const parsed = attach3mfParsed;
  document.getElementById('import3mf-title').textContent = `Select plate to attach (${parsed.plates.length} plate${parsed.plates.length > 1 ? 's' : ''})`;

  const rows = parsed.plates.map((pl, i) => {
    const thumb = parsed.thumbnails?.[pl.index];
    const nameDefault = pl.plateName || pl.objects?.join(', ') || `Plate ${pl.index}`;
    const typeInfo = pl.filamentType || '';
    const colorDots = (pl.filaments || []).map(f =>
      f.color ? `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${f.color};border:1px solid rgba(0,0,0,.15)" title="${typeof ntc !== 'undefined' ? ntc.name(f.color)?.[1] || '' : ''}"></span>` : ''
    ).join(' ');

    return `<div class="attach-plate-option" data-plate-index="${pl.index}" onclick="confirmAttachPlate(${pl.index})" style="display:flex;gap:12px;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;cursor:pointer;transition:border-color .15s">
      ${thumb ? `<img src="${thumb}" style="width:64px;height:64px;object-fit:cover;border-radius:4px;border:1px solid var(--border)" alt="">` : ''}
      <div style="flex:1">
        <strong>${escHtml(nameDefault)}</strong>
        <span style="color:var(--text-muted);font-size:12px">${typeInfo}${pl.bedType ? ` / ${formatBedType(pl.bedType)}` : ''}</span>
        ${colorDots}
        <div style="font-size:13px;margin-top:4px">${Math.floor(pl.printTimeMinutes/60)}h ${Math.round(pl.printTimeMinutes%60)}m — ${(pl.weightGrams||0).toFixed(1)}g</div>
      </div>
    </div>`;
  });

  document.getElementById('import3mf-body').innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">${rows.join('')}</div>`;
  document.getElementById('btn-import3mf-save').style.display = 'none'; // selection by clicking a plate
}

async function confirmAttachPlate(plateIndex) {
  const btn = document.querySelector(`.attach-plate-option[data-plate-index="${plateIndex}"]`);
  if (btn) { btn.style.opacity = '.5'; btn.style.pointerEvents = 'none'; btn.innerHTML += '<div style="text-align:center;padding:4px;color:var(--primary)">Attaching...</div>'; }

  const res = await fetch(`/api/jobs/${attachJobId}/attach-3mf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Plate-Index': String(plateIndex) },
    body: attach3mfBuffer,
  });

  if (!res.ok) { alert('Failed to attach 3MF'); }
  closeModal('import3mf-modal');
  attachJobId = null;
  attach3mfBuffer = null;
  attach3mfParsed = null;
  await renderCalendar();
}

// =============================================================================
// Preview image lightbox (click a job's preview thumbnail to view it full-size)
// =============================================================================
function openImgLightbox(src) {
  const box = document.getElementById('img-lightbox');
  document.getElementById('img-lightbox-img').src = src;
  box.style.display = 'flex';
}
function closeImgLightbox() {
  const box = document.getElementById('img-lightbox');
  box.style.display = 'none';
  document.getElementById('img-lightbox-img').src = '';
}
function initImgLightbox() {
  const box = document.getElementById('img-lightbox');
  const thumb = document.getElementById('job-thumb-img');
  thumb.addEventListener('click', () => { if (thumb.src) openImgLightbox(thumb.src); });
  // Click the backdrop (but not the image itself) or the close button to dismiss.
  // Escape is handled by the shared keydown handler in init().
  box.addEventListener('click', e => { if (e.target !== document.getElementById('img-lightbox-img')) closeImgLightbox(); });
}

// =============================================================================
// Bootstrap
// =============================================================================
document.addEventListener('DOMContentLoaded', () => { init(); initImport3mf(); initAttach3mf(); initImgLightbox(); });
