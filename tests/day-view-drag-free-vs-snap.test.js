/**
 * @jest-environment jsdom
 *
 * Drag placement: free by default, snap-to-avoid-overlap only with a modifier.
 *
 * Since jobs now render side-by-side when they overlap, snapping a dragged job
 * clear of its neighbours is counterproductive as the default. onDragMove()
 * therefore only calls snapAvoidingJobs() when CTRL (or Cmd on Mac) is held on
 * the event; otherwise the job lands at the raw dropped time (15-min grid).
 *
 * Drives the real onDragMove() over both snapping drag paths (reposition "move"
 * and queue→schedule) under jsdom and asserts the committed position.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const NAV = new Date('2026-07-29T12:00:00');
const P   = { id: 5, name: 'P', color: '#0088cc', favourite: 1, warm_up_mins: 0, cool_down_mins: 15, brand: 'bambulab' };

// Obstacle job 1: 05:00–06:00 (300–360 min from local midnight). With cool-down
// 15 its blocking interval is [300, 375]. A drop proposed at 300 min overlaps it.
const oStart = new Date(NAV); oStart.setHours(5, 0, 0, 0);
const oEnd   = new Date(NAV); oEnd.setHours(6, 0, 0, 0);
const CACHE  = { 1: { id: 1, printerId: 5, queued: 0, start: oStart.toISOString(), end: oEnd.toISOString(), cool_down_mins: 15 } };

function boot() {
  document.open();
  document.write(HTML);
  document.close();

  window.fetch = () => Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => null });
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };

  window.eval(APP + `
    ;window.__T__ = {
      onDragMove,
      snapAvoidingJobs,
      snap15,
      get PX_PER_MIN(){ return PX_PER_MIN; },
      setDrag(d){ drag = d; },
      getDrag(){ return drag; },
      setEnv(o){ if(o.printers) printers = o.printers; if(o.navDate) navDate = o.navDate; if(o.jobsCache) jobsCache = o.jobsCache; },
      neutralize(){
        init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){};
        renderMobilePrinterSwitcher = function(){}; applyMobilePrinterFilter = function(){};
        attachMobileDayViewSwipe = function(){}; scrollToNow = function(){};
        renderCalendar = async function(){};
      },
    };`);

  const T = window.__T__;
  T.neutralize();
  T.setEnv({ printers: [P], navDate: NAV, jobsCache: CACHE });
  return T;
}

// A .day-printer-col that reports a fixed on-screen rect (jsdom returns zeros).
function makeCol(T) {
  const col = document.createElement('div');
  col.className = 'day-printer-col';
  col.dataset.printerId = '5';
  col.getBoundingClientRect = () => ({ left: 0, right: 1000, top: 0, bottom: 100000, width: 1000, height: 100000 });
  document.body.appendChild(col);
  return col;
}

describe('drag "move" — free by default, snaps only with modifier', () => {
  // proposed drop at 300 min overlaps obstacle [300,375]; snapAvoidingJobs → 375.
  const PROPOSED = 300;
  const EXPECT_SNAP = 375;

  function runMove(mods) {
    const T = boot();
    const col = makeCol(T);
    const jobEl = document.createElement('div');
    col.appendChild(jobEl);
    const clientY = PROPOSED * T.PX_PER_MIN; // pxToMin(clientY) === PROPOSED
    T.setDrag({
      type: 'move', jobId: 999, printerId: 5, colEl: col, jobEl,
      offsetMins: 0, durationMins: 60, currentTopMins: 0,
      warmUpEl: null, coolDownEl: null, warmUpMins: 0,
    });
    // clientX=5 keeps hoveredCol === colEl (no zero-width column match).
    T.onDragMove({ clientX: 5, clientY, ...mods });
    return T.getDrag().currentTopMins;
  }

  test('no modifier → free placement at raw dropped time (no snap)', () => {
    expect(runMove({})).toBe(PROPOSED);
  });

  test('CTRL held → snaps clear of the obstacle (legacy behaviour)', () => {
    expect(runMove({ ctrlKey: true })).toBe(EXPECT_SNAP);
  });

  test('Cmd/meta held → also snaps (Mac ergonomics)', () => {
    expect(runMove({ metaKey: true })).toBe(EXPECT_SNAP);
  });

  test('sanity: snapped target differs from free target', () => {
    expect(EXPECT_SNAP).not.toBe(PROPOSED);
  });
});

describe('drag "queue-schedule" — free by default, snaps only with modifier', () => {
  const PROPOSED = 300;
  const EXPECT_SNAP = 375;

  function runQueue(mods) {
    const T = boot();
    makeCol(T);
    const ghostEl = document.createElement('div');
    document.body.appendChild(ghostEl);
    const clientY = PROPOSED * T.PX_PER_MIN;
    T.setDrag({
      type: 'queue-schedule', jobId: 999, durationMins: 60,
      ghostEl, previewEl: null, colEl: null, printerId: null, currentMins: null,
    });
    // clientX inside the col rect [0,1000] and clientY inside [0,100000].
    T.onDragMove({ clientX: 100, clientY });
    // Re-run with modifier if requested (fresh preview each move is fine).
    if (mods && (mods.ctrlKey || mods.metaKey)) T.onDragMove({ clientX: 100, clientY, ...mods });
    return T.getDrag().currentMins;
  }

  test('no modifier → free placement at raw dropped time (no snap)', () => {
    expect(runQueue({})).toBe(PROPOSED);
  });

  test('CTRL held → snaps clear of the obstacle', () => {
    expect(runQueue({ ctrlKey: true })).toBe(EXPECT_SNAP);
  });

  test('Cmd/meta held → also snaps', () => {
    expect(runQueue({ metaKey: true })).toBe(EXPECT_SNAP);
  });
});
