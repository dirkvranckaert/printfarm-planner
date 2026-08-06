/**
 * @jest-environment jsdom
 *
 * Printer-lock on drag (client-side), driving the real onDragMove() under jsdom:
 *   - a printer-BOUND "move" job rejects a hover over another printer's lane
 *     (stays locked to its own column);
 *   - a printer-BOUND queued job rejects a drop target on another lane
 *     (no preview / no placement), but lands fine on its OWN lane;
 *   - an UNASSIGNED queued job keeps full freedom (any lane accepts it).
 * Also guards the queue context-menu gating: the menu only opens for a bound job.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const NAV = new Date('2026-07-29T12:00:00');
const P5  = { id: 5, name: 'P5', color: '#0088cc', favourite: 1, warm_up_mins: 0, cool_down_mins: 15 };
const P6  = { id: 6, name: 'P6', color: '#cc4400', favourite: 1, warm_up_mins: 0, cool_down_mins: 15 };

function boot(cache, jobsForGet) {
  document.open();
  document.write(HTML);
  document.close();

  window.fetch = (url) => Promise.resolve({
    ok: true, status: 200, text: async () => '',
    json: async () => (String(url).includes('/api/jobs') ? (jobsForGet || []) : null),
  });
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };

  window.eval(APP + `
    ;window.__T__ = {
      onDragMove, showQueueCtxMenu, renderQueuePanel,
      get PX_PER_MIN(){ return PX_PER_MIN; },
      setDrag(d){ drag = d; },
      getDrag(){ return drag; },
      setEnv(o){ if(o.printers) printers = o.printers; if(o.navDate) navDate = o.navDate; if(o.jobsCache) jobsCache = o.jobsCache; if(o.view) view = o.view; if(o.showQueuePanel!==undefined) showQueuePanel = o.showQueuePanel; },
      neutralize(){
        init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){};
        renderMobilePrinterSwitcher = function(){}; applyMobilePrinterFilter = function(){};
        attachMobileDayViewSwipe = function(){}; scrollToNow = function(){};
        renderCalendar = async function(){};
      },
    };`);

  const T = window.__T__;
  T.neutralize();
  T.setEnv({ printers: [P5, P6], navDate: NAV, jobsCache: cache || {} });
  return T;
}

// A .day-printer-col with a fixed on-screen rect (jsdom returns zeros otherwise).
function makeCol(id, left, right) {
  const col = document.createElement('div');
  col.className = 'day-printer-col';
  col.dataset.printerId = String(id);
  col.getBoundingClientRect = () => ({ left, right, top: 0, bottom: 100000, width: right - left, height: 100000 });
  document.body.appendChild(col);
  return col;
}

describe('printer-lock on drag (jsdom)', () => {
  test('bound "move" job will not switch to another printer lane', () => {
    const T = boot();
    const col5 = makeCol(5, 0, 500);
    const col6 = makeCol(6, 500, 1000);
    const jobEl = document.createElement('div');
    col5.appendChild(jobEl);
    T.setDrag({
      type: 'move', jobId: 999, job: { printerId: 5 }, printerId: 5, colEl: col5, jobEl,
      offsetMins: 0, durationMins: 60, currentTopMins: 0, warmUpEl: null, coolDownEl: null, warmUpMins: 0,
    });
    // Cursor over col6 (clientX 750) — must be ignored for a bound job.
    T.onDragMove({ clientX: 750, clientY: 100 * T.PX_PER_MIN });
    const d = T.getDrag();
    expect(d.printerId).toBe(5);      // still its own printer
    expect(d.colEl).toBe(col5);       // element never moved to col6
  });

  test('bound queued job: another lane is not a valid drop target', () => {
    const T = boot({ 999: { id: 999, printerId: 5, queued: 1 } });
    makeCol(5, 0, 500);
    makeCol(6, 500, 1000);
    const ghostEl = document.createElement('div');
    document.body.appendChild(ghostEl);
    T.setDrag({ type: 'queue-schedule', jobId: 999, durationMins: 60, ghostEl, previewEl: null, colEl: null, printerId: null, currentMins: null });
    T.onDragMove({ clientX: 750, clientY: 300 * T.PX_PER_MIN }); // over col6
    const d = T.getDrag();
    expect(d.currentMins).toBeNull();
    expect(d.printerId).toBeNull();
  });

  test('bound queued job: its OWN lane accepts the drop', () => {
    const T = boot({ 999: { id: 999, printerId: 5, queued: 1 } });
    makeCol(5, 0, 500);
    makeCol(6, 500, 1000);
    const ghostEl = document.createElement('div');
    document.body.appendChild(ghostEl);
    T.setDrag({ type: 'queue-schedule', jobId: 999, durationMins: 60, ghostEl, previewEl: null, colEl: null, printerId: null, currentMins: null });
    T.onDragMove({ clientX: 100, clientY: 300 * T.PX_PER_MIN }); // over col5
    const d = T.getDrag();
    expect(d.printerId).toBe(5);
    expect(d.currentMins).toBe(300);
  });

  test('unassigned queued job keeps freedom to land on any lane', () => {
    const T = boot({ 998: { id: 998, printerId: null, queued: 1 } });
    makeCol(5, 0, 500);
    makeCol(6, 500, 1000);
    const ghostEl = document.createElement('div');
    document.body.appendChild(ghostEl);
    T.setDrag({ type: 'queue-schedule', jobId: 998, durationMins: 60, ghostEl, previewEl: null, colEl: null, printerId: null, currentMins: null });
    T.onDragMove({ clientX: 750, clientY: 300 * T.PX_PER_MIN }); // over col6 — allowed
    const d = T.getDrag();
    expect(d.printerId).toBe(6);
    expect(d.currentMins).toBe(300);
  });
});

describe('queue context-menu gating (jsdom)', () => {
  const rightClick = (el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));

  test('right-click opens the menu for a BOUND queue job but not for an UNASSIGNED one', async () => {
    const jobs = [
      { id: 1, name: 'Bound',   queued: 1, printerId: 5, durationMins: 60, start: '', end: '' },
      { id: 2, name: 'Loose',   queued: 1, printerId: null, durationMins: 60, start: '', end: '' },
    ];
    const T = boot({}, jobs);
    T.setEnv({ view: 'day', showQueuePanel: true });
    await T.renderQueuePanel();

    const items = document.querySelectorAll('.queue-item');
    expect(items).toHaveLength(2);
    const menu = document.getElementById('queue-ctx-menu');

    // Unassigned job → no menu.
    rightClick([...items].find(i => i.dataset.printer === ''));
    expect(menu.classList.contains('hidden')).toBe(true);

    // Bound job → menu opens.
    rightClick([...items].find(i => i.dataset.printer === '5'));
    expect(menu.classList.contains('hidden')).toBe(false);
  });
});
