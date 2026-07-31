/**
 * @jest-environment jsdom
 *
 * Day-view vertical scaling (PX_PER_MIN != 1).
 *
 * Regression guard for the "grid fills viewport height" feature: on a tall
 * window the 24h grid grows so 1 minute renders as >1px, and EVERY overlay
 * (job blocks, the now-line, buffers, drag targets) must position through
 * minToPx() rather than treating minutes as raw pixels.
 *
 * jsdom reports clientHeight 0 by default, which clamps the scale to the floor
 * (PX_PER_MIN = 1) — so the rest of the suite can never catch overlay drift at
 * scale > 1. Here we stub #day-scroll.clientHeight to 2880 (= 24h * 120px),
 * forcing PX_PER_MIN = 2, and assert overlays land at minToPx(mins), not mins.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const NAV = new Date(); NAV.setHours(0, 0, 0, 0); // today's local midnight → now-line renders

// One job 02:00–03:00 local on the nav day → startMins = 120, so at scale 2 its
// top must be 240px (minToPx), never 120px (raw).
const JOB_START = new Date(NAV); JOB_START.setHours(2, 0, 0, 0);
const JOB_END   = new Date(NAV); JOB_END.setHours(3, 0, 0, 0);
const JOB_START_MINS = 120;

const JOBS = [
  { id: 900, printerId: 5, name: 'Scale probe', customerName: 'X', orderNr: 'S1',
    start: JOB_START.toISOString(), end: JOB_END.toISOString(), status: 'Planned',
    queued: 0, linked_printer_id: null, colors: null, bedType: 'Textured', durationMins: 60 },
];

function bootDayView() {
  document.open();
  document.write(HTML);
  document.close();

  // Force #day-scroll to report a tall viewport so computeDayScale() → 2.
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return this.id === 'day-scroll' ? 2880 : 0; },
  });

  window.fetch = (url) => {
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
      updateNowLine,
      minToPx,
      get PX_PER_MIN(){ return PX_PER_MIN; },
      setEnv(o){ if(o.printers) printers = o.printers; if(o.navDate) navDate = o.navDate; },
      neutralize(){
        init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){};
        renderMobilePrinterSwitcher = function(){}; applyMobilePrinterFilter = function(){};
        attachMobileDayViewSwipe = function(){}; scrollToNow = function(){};
      },
    };`);

  const T = window.__T__;
  T.neutralize();
  T.setEnv({
    printers: [{ id: 5, name: 'Bambulab H2C', color: '#0088cc', favourite: 1, warm_up_mins: 0, cool_down_mins: 0, brand: 'bambulab' }],
    navDate: NAV,
  });
  return T;
}

describe('day view — overlays scale with PX_PER_MIN on a tall viewport', () => {
  let T;

  beforeAll(async () => {
    T = bootDayView();
    await T.renderDay();
  });

  test('a tall viewport drives PX_PER_MIN above the floor (here = 2)', () => {
    expect(T.PX_PER_MIN).toBeCloseTo(2, 5);
  });

  test('the grid body height is scaled (1440 min → minToPx(1440))', () => {
    const body = document.querySelector('.day-view-body');
    expect(parseFloat(body.style.height)).toBeCloseTo(T.minToPx(1440), 5);
  });

  test('a job block top uses minToPx(startMins), not raw minutes', () => {
    const block = document.querySelector('.job-block[data-job-id="900"]');
    expect(block).not.toBeNull();
    const top = parseFloat(block.style.top);
    expect(top).toBeCloseTo(T.minToPx(JOB_START_MINS), 5); // 240 at scale 2
    expect(top).not.toBeCloseTo(JOB_START_MINS, 5);        // would be 120 if minToPx were dropped
  });

  test('the now-line rendered by renderDay is scaled', () => {
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const line = document.querySelector('.now-line');
    expect(line).not.toBeNull();
    expect(parseFloat(line.style.top)).toBeCloseTo(T.minToPx(nowMins), 0);
  });

  test('updateNowLine() (60s tick) keeps the now-line scaled — no jump to raw minutes', () => {
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    T.updateNowLine();
    const line = document.querySelector('.now-line');
    expect(parseFloat(line.style.top)).toBeCloseTo(T.minToPx(nowMins), 0);
  });
});
