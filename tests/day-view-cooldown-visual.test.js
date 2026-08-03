/**
 * @jest-environment jsdom
 *
 * Client cool-down VISUALS derive from the job's own snapshotted
 * `cool_down_mins`, not the printer scalar.
 *
 * Server-side scheduling is already per-job authoritative; this guards the two
 * client render paths that used to read `printer.cool_down_mins`:
 *   1. the day-view "Cool-down" buffer block drawn after a job, and
 *   2. the drag / slot-preview snap gap (snapAvoidingJobs).
 *
 * Attribution mirrors the server: the gap after job X uses X's OWN cool-down
 * (the finishing job owns its trailing buffer). Fallback is job → printer → 15.
 *
 * As in day-view-scale.test.js we stub #day-scroll.clientHeight to force
 * PX_PER_MIN = 2, so the buffer height must route through minToPx() (no raw
 * *60 px math) AND use the job value — 45 min → minToPx(45) = 90px.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const NAV = new Date(); NAV.setHours(0, 0, 0, 0);

// Job 02:00–03:00 local; printer scalar cool-down = 10, job override = 45.
const JOB_START = new Date(NAV); JOB_START.setHours(2, 0, 0, 0);
const JOB_END   = new Date(NAV); JOB_END.setHours(3, 0, 0, 0);
const JOB_COOLDOWN = 45;
const PRINTER_COOLDOWN = 10;

const JOBS = [
  { id: 900, printerId: 5, name: 'Override probe', customerName: 'X', orderNr: 'S1',
    start: JOB_START.toISOString(), end: JOB_END.toISOString(), status: 'Planned',
    queued: 0, linked_printer_id: null, colors: null, bedType: 'Textured',
    durationMins: 60, cool_down_mins: JOB_COOLDOWN },
];

function boot() {
  document.open();
  document.write(HTML);
  document.close();

  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return this.id === 'day-scroll' ? 2880 : 0; },
  });

  window.__CALLS__ = [];
  window.fetch = (url, opts) => {
    window.__CALLS__.push({ url, method: opts?.method, body: opts?.body });
    let data = null;
    if (url === '/api/jobs') data = JOBS;
    else {
      const m = /\/api\/jobs\/(\d+)$/.exec(url);
      if (m) data = JOBS.find(j => j.id === Number(m[1])) || null;
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => data });
  };
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };

  window.eval(APP + `
    ;window.__T__ = {
      renderDay,
      minToPx,
      snapAvoidingJobs,
      detectConflicts,
      resolveConflictMoveAfter,
      get PX_PER_MIN(){ return PX_PER_MIN; },
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
  T.setEnv({
    printers: [{ id: 5, name: 'Bambulab H2C', color: '#0088cc', favourite: 1,
      warm_up_mins: 0, cool_down_mins: PRINTER_COOLDOWN, brand: 'bambulab' }],
    navDate: NAV,
  });
  return T;
}

describe('day-view cool-down buffer block uses the job cool-down, not the printer scalar', () => {
  let T;
  beforeAll(async () => {
    T = boot();
    await T.renderDay();
  });

  test('PX_PER_MIN forced above the floor (= 2)', () => {
    expect(T.PX_PER_MIN).toBeCloseTo(2, 5);
  });

  test('cool-down block height = minToPx(job.cool_down_mins), not the printer value', () => {
    const buf = document.querySelector('.buffer-block[data-job-id="900"][data-buffer-type="cooldown"]');
    expect(buf).not.toBeNull();
    const ht = parseFloat(buf.style.height);
    expect(ht).toBeCloseTo(T.minToPx(JOB_COOLDOWN), 5);     // 90 at scale 2
    expect(ht).not.toBeCloseTo(T.minToPx(PRINTER_COOLDOWN), 5); // would be 20 off the printer scalar
    expect(ht).not.toBeCloseTo(JOB_COOLDOWN, 5);            // would be 45 if minToPx were dropped
  });
});

describe('snapAvoidingJobs slot-preview gap attributes cool-down per finishing job', () => {
  // Printer scalar cool-down = 10 (distinct from every job override below).
  // Obstacle A: 05:00–06:00 (300–360 min), own cool-down 60.
  // Moving job M: id 2, own cool-down 30, duration 60.
  const P = { id: 5, name: 'P', color: '#000', favourite: 1, warm_up_mins: 0, cool_down_mins: 10 };
  const aStart = new Date(NAV); aStart.setHours(5, 0, 0, 0);
  const aEnd   = new Date(NAV); aEnd.setHours(6, 0, 0, 0);
  const CACHE = {
    1: { id: 1, printerId: 5, queued: 0, start: aStart.toISOString(), end: aEnd.toISOString(), cool_down_mins: 60 },
    2: { id: 2, printerId: 5, queued: 1, start: aStart.toISOString(), end: aEnd.toISOString(), cool_down_mins: 30 },
  };
  let T;
  beforeAll(() => {
    T = boot();
    T.setEnv({ printers: [P], navDate: NAV, jobsCache: CACHE });
  });

  test('snapping AFTER an obstacle uses the obstacle\'s OWN cool-down (60), not the printer scalar (10)', () => {
    // proposedStart 340 overlaps A; nearest boundary is "after" = A.end(360) + A.cool(60) = 420.
    expect(T.snapAvoidingJobs(340, 60, 5, 2)).toBeCloseTo(420, 5); // old printer-scalar code → 370
  });

  test('snapping BEFORE an obstacle uses the MOVING job\'s OWN cool-down (30), not the printer scalar (10)', () => {
    // proposedStart 305 → nearest boundary is "before" = A.start(300) - dur(60) - M.cool(30) = 210.
    expect(T.snapAvoidingJobs(305, 60, 5, 2)).toBeCloseTo(210, 5); // old printer-scalar code → 230
  });
});

describe('detectConflicts fires per-job: the ⚠ warning uses each job\'s own cool-down', () => {
  // Jobs A (05:00–06:00) and B (06:30–07:30) on one printer, 30-min gap between.
  const aStart = new Date(NAV); aStart.setHours(5, 0, 0, 0);
  const aEnd   = new Date(NAV); aEnd.setHours(6, 0, 0, 0);
  const bStart = new Date(NAV); bStart.setHours(6, 30, 0, 0);
  const bEnd   = new Date(NAV); bEnd.setHours(7, 30, 0, 0);
  const mkJobs = (aCd) => ([
    { id: 1, printerId: 5, queued: 0, start: aStart.toISOString(), end: aEnd.toISOString(), cool_down_mins: aCd },
    { id: 2, printerId: 5, queued: 0, start: bStart.toISOString(), end: bEnd.toISOString(), cool_down_mins: 15 },
  ]);
  let T;
  beforeAll(() => { T = boot(); });

  test('an override that closes the gap RAISES a conflict the printer scalar (10) would miss', () => {
    // A's own 45-min cool-down → A busy until 06:45, overlapping B at 06:30.
    const ids = T.detectConflicts(mkJobs(45), { 5: { cool_down_mins: 10, warm_up_mins: 0 } });
    expect(ids.size).toBe(2); // printer-scalar code → 06:10, no overlap, size 0
  });

  test('an override that leaves a gap CLEARS a conflict the printer scalar (45) would falsely raise', () => {
    // A's own 10-min cool-down → A busy until 06:10, clear of B at 06:30.
    const ids = T.detectConflicts(mkJobs(10), { 5: { cool_down_mins: 45, warm_up_mins: 0 } });
    expect(ids.size).toBe(0); // printer-scalar code → 06:45, overlap, size 2
  });
});

describe('resolveConflictMoveAfter writes a slot from the finishing job\'s own cool-down', () => {
  // Obstacle A 05:00–06:00 (own cool-down 60); moving job M 05:30–06:30 (dur 60)
  // overlaps A. New start must clear A.end + A.cool(60) = 07:00, not printer(10).
  const aStart = new Date(NAV); aStart.setHours(5, 0, 0, 0);
  const aEnd   = new Date(NAV); aEnd.setHours(6, 0, 0, 0);
  const mStart = new Date(NAV); mStart.setHours(5, 30, 0, 0);
  const mEnd   = new Date(NAV); mEnd.setHours(6, 30, 0, 0);
  const CACHE = {
    1: { id: 1, printerId: 5, queued: 0, start: aStart.toISOString(), end: aEnd.toISOString(), cool_down_mins: 60 },
    2: { id: 2, printerId: 5, queued: 0, start: mStart.toISOString(), end: mEnd.toISOString(), cool_down_mins: 30 },
  };
  let T, patch;
  beforeAll(async () => {
    T = boot();
    T.setEnv({
      printers: [{ id: 5, name: 'P', color: '#000', favourite: 1, warm_up_mins: 0, cool_down_mins: 10 }],
      navDate: NAV,
      jobsCache: CACHE,
    });
    await T.resolveConflictMoveAfter(2);
    const call = window.__CALLS__.find(c => c.method === 'PATCH' && /\/api\/jobs\/2$/.test(c.url));
    patch = call ? JSON.parse(call.body) : null;
  });

  test('PATCHes the moved job to A.end + A.cool_down_mins(60), not printer scalar(10)', () => {
    expect(patch).not.toBeNull();
    const expectedStart = new Date(aEnd.getTime() + 60 * 60000);           // 07:00
    const expectedEnd   = new Date(expectedStart.getTime() + 60 * 60000);  // 08:00
    expect(patch.start).toBe(expectedStart.toISOString());
    expect(patch.end).toBe(expectedEnd.toISOString());
    // printer-scalar code would have written A.end + 10 = 06:10
    expect(patch.start).not.toBe(new Date(aEnd.getTime() + 10 * 60000).toISOString());
  });
});
