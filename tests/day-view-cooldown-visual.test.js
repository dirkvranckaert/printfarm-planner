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
const RESHOVE = fs.readFileSync(path.join(__dirname, '..', 'public', 'reshoveMove.js'), 'utf8');

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

  window.eval(RESHOVE + ';' + APP + `
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

// Guards the per-printer sweep-line implementation (multi-job clusters,
// per-printer isolation, and a long disjoint history — the accumulation that
// used to blow up the old O(n²) pair scan).
describe('detectConflicts sweep: clusters, printer isolation, disjoint history', () => {
  const at = (h, m) => { const d = new Date(NAV); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const noBuf = { cool_down_mins: 0, warm_up_mins: 0 };
  let T;
  beforeAll(() => { T = boot(); });

  test('transitive cluster: A–B overlap, B–C overlap, A–C disjoint → all three flagged', () => {
    const jobs = [
      { id: 1, printerId: 5, queued: 0, start: at(5, 0),  end: at(6, 0),  cool_down_mins: 0, warm_up_mins: 0 },
      { id: 2, printerId: 5, queued: 0, start: at(5, 30), end: at(6, 30), cool_down_mins: 0, warm_up_mins: 0 },
      { id: 3, printerId: 5, queued: 0, start: at(6, 15), end: at(7, 0),  cool_down_mins: 0, warm_up_mins: 0 },
    ];
    const ids = T.detectConflicts(jobs, { 5: noBuf });
    expect([...ids].sort()).toEqual([1, 2, 3]);
  });

  test('non-immediate retention: long A spans B and C (A–B, A–C overlap; B–C disjoint), fed UNSORTED', () => {
    // A 05:00–08:00 stays the max-end witness across B, so the sweep must retain
    // A (not the immediately-preceding B) to flag the A–C overlap. Feeding these
    // out of start-order also guards the internal sort.
    const jobs = [
      { id: 3, printerId: 5, queued: 0, start: at(7, 0), end: at(7, 30), cool_down_mins: 0, warm_up_mins: 0 }, // C
      { id: 1, printerId: 5, queued: 0, start: at(5, 0), end: at(8, 0),  cool_down_mins: 0, warm_up_mins: 0 }, // A
      { id: 2, printerId: 5, queued: 0, start: at(6, 0), end: at(6, 30), cool_down_mins: 0, warm_up_mins: 0 }, // B
    ];
    const ids = T.detectConflicts(jobs, { 5: noBuf });
    expect([...ids].sort()).toEqual([1, 2, 3]); // A–B and A–C overlap; B–C disjoint but both share A
  });

  test('reverse-ordered DISJOINT intervals stay conflict-free — structurally guards the pre-sweep sort', () => {
    // Fed latest-start-first, all three windows disjoint. The running-max sweep is
    // correct ONLY on start-sorted input. Drop `finite.sort` and the first (latest)
    // interval seeds maxEnd high, so every later (earlier-start) interval reads
    // cur.s < maxEnd and is FALSELY flagged against the witness: {} becomes {1,2,3}.
    // The pre-existing transitive test above returns {1,2,3} either way, so THIS
    // is the case that actually fails if the sort is removed.
    const jobs = [
      { id: 3, printerId: 5, queued: 0, start: at(6, 0), end: at(7, 0), cool_down_mins: 0, warm_up_mins: 0 },
      { id: 2, printerId: 5, queued: 0, start: at(4, 0), end: at(5, 0), cool_down_mins: 0, warm_up_mins: 0 },
      { id: 1, printerId: 5, queued: 0, start: at(2, 0), end: at(3, 0), cool_down_mins: 0, warm_up_mins: 0 },
    ];
    const ids = T.detectConflicts(jobs, { 5: noBuf });
    expect(ids.size).toBe(0); // sort removed → {1,2,3}
  });

  test('non-finite (unparseable) interval is excluded and cannot hide a real conflict', () => {
    // Finding 1: A 09:00–12:00 and B 10:00–13:00 overlap; X has unparseable
    // start/end (NaN). A NaN in the comparator would corrupt the sort and could
    // hide {A,B}. X must be dropped BEFORE sorting; result is exactly {A,B}.
    const jobs = [
      { id: 1, printerId: 5, queued: 0, start: at(9, 0),  end: at(12, 0), cool_down_mins: 0, warm_up_mins: 0 },
      { id: 2, printerId: 5, queued: 0, start: '',         end: '',        cool_down_mins: 0, warm_up_mins: 0 },
      { id: 3, printerId: 5, queued: 0, start: at(10, 0), end: at(13, 0), cool_down_mins: 0, warm_up_mins: 0 },
    ];
    const ids = T.detectConflicts(jobs, { 5: noBuf });
    expect([...ids].sort()).toEqual([1, 3]);
  });

  test('NaN interval BETWEEN reverse-ordered disjoint finite intervals stays inert — guards the pre-sort exclusion', () => {
    // Two disjoint finite intervals fed latest-start-first with an unparseable
    // (NaN) interval between them. The Number.isFinite guard drops X BEFORE the
    // sort, so the finite pair sorts correctly (02:00 before 06:00) and never
    // conflicts → {}. Remove the guard and NaN poisons the comparator: the sort
    // cannot move 02:00 ahead of 06:00 (every compare vs NaN is treated as 0), so
    // the array stays [06:00, X, 02:00]; the 02:00 interval then reads
    // cur.s < maxEnd(07:00) and is falsely flagged with the 06:00 witness → {1,3}.
    // Unlike the test above (where A/B genuinely overlap, so the guard's removal is
    // invisible), the finite intervals here are disjoint — the ONLY route to a
    // conflict is a corrupted, NaN-poisoned sort.
    const jobs = [
      { id: 1, printerId: 5, queued: 0, start: at(6, 0), end: at(7, 0), cool_down_mins: 0, warm_up_mins: 0 },
      { id: 2, printerId: 5, queued: 0, start: '',        end: '',        cool_down_mins: 0, warm_up_mins: 0 },
      { id: 3, printerId: 5, queued: 0, start: at(2, 0), end: at(3, 0), cool_down_mins: 0, warm_up_mins: 0 },
    ];
    const ids = T.detectConflicts(jobs, { 5: noBuf });
    expect(ids.size).toBe(0); // guard removed → {1,3}
  });

  test('reversed interval (end before start) does not raise a false conflict', () => {
    // Finding 2: A 09:00–12:00, B 10:00–08:00 (end before start). The old pair
    // scan finds {} (A.s < B.e is false); the sweep must not falsely flag {A,B}.
    const jobs = [
      { id: 1, printerId: 5, queued: 0, start: at(9, 0),  end: at(12, 0), cool_down_mins: 0, warm_up_mins: 0 },
      { id: 2, printerId: 5, queued: 0, start: at(10, 0), end: at(8, 0),  cool_down_mins: 0, warm_up_mins: 0 },
    ];
    const ids = T.detectConflicts(jobs, { 5: noBuf });
    expect(ids.size).toBe(0);
  });

  test('reversed interval that genuinely conflicts is still flagged (exact all-pairs contract)', () => {
    // A reversed interval CAN conflict when a normal interval spans its gap:
    // P 07:00–13:00 (normal), R 12:00–08:00 (reversed). Old pair scan:
    // R.s(12:00) < P.e(13:00) && P.s(07:00) < R.e(08:00) → {P,R}. Must match.
    const jobs = [
      { id: 1, printerId: 5, queued: 0, start: at(7, 0),  end: at(13, 0), cool_down_mins: 0, warm_up_mins: 0 },
      { id: 2, printerId: 5, queued: 0, start: at(12, 0), end: at(8, 0),  cool_down_mins: 0, warm_up_mins: 0 },
    ];
    const ids = T.detectConflicts(jobs, { 5: noBuf });
    expect([...ids].sort()).toEqual([1, 2]);
  });

  test('same time slot but different printers → no conflict', () => {
    const jobs = [
      { id: 1, printerId: 5, queued: 0, start: at(5, 0), end: at(6, 0), cool_down_mins: 0, warm_up_mins: 0 },
      { id: 2, printerId: 6, queued: 0, start: at(5, 0), end: at(6, 0), cool_down_mins: 0, warm_up_mins: 0 },
    ];
    const ids = T.detectConflicts(jobs, { 5: noBuf, 6: noBuf });
    expect(ids.size).toBe(0);
  });

  test('long back-to-back disjoint history: flags nothing AND reads each field once (no O(n²) re-reads)', () => {
    // start/end are getters with read counters. The O(n log n) sweep parses each
    // job's interval exactly once up front; an O(n²) pair scan would re-read the
    // same fields many times over, so per-field read counts guard the perf claim
    // (finding 5) in a way a disjoint-set-size assertion alone cannot.
    const N = 200;
    let startReads = 0, endReads = 0;
    const jobs = [];
    for (let i = 0; i < N; i++) {
      const s = new Date(NAV); s.setHours(0, 0, 0, 0); s.setMinutes(i * 6);
      const e = new Date(s.getTime() + 5 * 60000); // 5-min job, 1-min gap
      const sIso = s.toISOString(), eIso = e.toISOString();
      jobs.push({
        id: i + 1, printerId: 5, queued: 0, cool_down_mins: 0, warm_up_mins: 0,
        get start() { startReads++; return sIso; },
        get end()   { endReads++;   return eIso; },
      });
    }
    const ids = T.detectConflicts(jobs, { 5: noBuf });
    expect(ids.size).toBe(0);
    expect(startReads).toBe(N); // exactly one start read per job
    expect(endReads).toBe(N);   // exactly one end read per job
  });

  test('dense overlap: N mutually-overlapping jobs flag all N with sub-quadratic Set writes (guards O(n log n))', () => {
    // The read-count test above only covers a DISJOINT history — its field-read
    // count stays exactly N even against the old bd42202 dense-overlap O(n²)
    // active.filter impl (both precompute the interval once). To guard the actual
    // complexity claim we need a DENSE-overlap case with an observable per-pair
    // signal. All N jobs share one identical window on one printer → every pair
    // overlaps. The O(n log n) sweep flags each conflicting job against a single
    // running-max witness: exactly 2 Set writes per job, O(n) total. The old
    // active.filter impl re-adds every still-open interval each step → O(n²) Set
    // writes. Counting Set.prototype.add invocations makes that per-pair work
    // observable where field-read counts cannot.
    const N = 200;
    const s = at(5, 0), e = at(6, 0);
    const jobs = [];
    for (let i = 0; i < N; i++) {
      jobs.push({ id: i + 1, printerId: 5, queued: 0, start: s, end: e, cool_down_mins: 0, warm_up_mins: 0 });
    }
    const realAdd = Set.prototype.add;
    let addCalls = 0;
    Set.prototype.add = function (v) { addCalls++; return realAdd.call(this, v); };
    let ids;
    try {
      ids = T.detectConflicts(jobs, { 5: noBuf });
    } finally {
      Set.prototype.add = realAdd;
    }
    expect(ids.size).toBe(N);                     // all N mutually overlap → all flagged
    expect(addCalls).toBeLessThanOrEqual(2 * N);  // O(n) sweep ≈ 2·(N-1); O(n²) filter ≈ N²/2 ≫ 2N
  });
});

describe('resolveConflictMoveAfter targets a slot from the finishing job\'s own cool-down', () => {
  // Obstacle A 05:00–06:00 (own cool-down 60); moving job M 05:30–06:30 (dur 60)
  // overlaps A. New start must clear A.end + A.cool(60) = 07:00, not printer(10).
  // B2: the move now funnels through the push-back pipeline (same fit -> confirm
  // -> cascade), so it POSTs /push-back with `to` = that computed slot.
  const aStart = new Date(NAV); aStart.setHours(5, 0, 0, 0);
  const aEnd   = new Date(NAV); aEnd.setHours(6, 0, 0, 0);
  const mStart = new Date(NAV); mStart.setHours(5, 30, 0, 0);
  const mEnd   = new Date(NAV); mEnd.setHours(6, 30, 0, 0);
  const CACHE = {
    1: { id: 1, printerId: 5, queued: 0, start: aStart.toISOString(), end: aEnd.toISOString(), cool_down_mins: 60 },
    2: { id: 2, printerId: 5, queued: 0, start: mStart.toISOString(), end: mEnd.toISOString(), cool_down_mins: 30 },
  };
  let T, body;
  beforeAll(async () => {
    T = boot();
    T.setEnv({
      printers: [{ id: 5, name: 'P', color: '#000', favourite: 1, warm_up_mins: 0, cool_down_mins: 10 }],
      navDate: NAV,
      jobsCache: CACHE,
    });
    await T.resolveConflictMoveAfter(2);
    const call = window.__CALLS__.find(c => c.method === 'POST' && /\/api\/jobs\/2\/push-back$/.test(c.url));
    body = call ? JSON.parse(call.body) : null;
  });

  test('POSTs push-back with to = A.end + A.cool_down_mins(60), not printer scalar(10)', () => {
    expect(body).not.toBeNull();
    const expectedStart = new Date(aEnd.getTime() + 60 * 60000);           // 07:00
    expect(body.to).toBe(expectedStart.toISOString());
    // printer-scalar code would have written A.end + 10 = 06:10
    expect(body.to).not.toBe(new Date(aEnd.getTime() + 10 * 60000).toISOString());
  });
});
