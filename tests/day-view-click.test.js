/**
 * @jest-environment jsdom
 *
 * Day-view click → job-detail mapping.
 *
 * Regression guard for the reported bug where clicking a job block in a printer
 * column appeared to open the WRONG job's detail dialog (two back-to-back
 * "Shipping Container" jobs on the Bambulab H2C column — one ending ~15:00, the
 * next running to end of day — opening each other's dialog).
 *
 * This drives the real public/app.js render + click handlers under jsdom against
 * that exact adjacent-jobs layout and asserts every block opens its OWN job.
 *
 * app.js is a classic browser script (no module exports), so it is evaluated
 * inside the jsdom window; a small appended hook exposes the internals the test
 * needs and neutralises the bootstrap (init/SSE/mobile) that is irrelevant here.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// Two back-to-back jobs on one printer column (the reported prod scenario):
//  - 152 starts the previous evening and ends early afternoon ("current" job)
//  - 162 starts ~15 min later and runs into the next day ("next" job)
// Same name + same customer, so only id / status / times distinguish them.
const JOBS = [
  { id: 152, printerId: 5, name: 'Shipping Container - ARGT', customerName: 'Nikki', orderNr: 'A1',
    start: '2026-07-28T20:48:00.220Z', end: '2026-07-29T12:53:00.220Z', status: 'Printing',
    queued: 0, linked_printer_id: 2, colors: null, bedType: 'Textured', durationMins: 965 },
  { id: 162, printerId: 5, name: 'Shipping Container - ARGT', customerName: 'Nikki', orderNr: 'A2',
    start: '2026-07-29T13:08:00.220Z', end: '2026-07-30T05:11:00.220Z', status: 'Planned',
    queued: 0, linked_printer_id: null, colors: null, bedType: 'Textured', durationMins: 963 },
];

function bootDayView() {
  document.open();
  document.write(HTML);
  document.close();

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
      setEnv(o){ if(o.printers) printers = o.printers; if(o.navDate) navDate = o.navDate; },
      setOpenRecorder(fn){ openJobModal = fn; },
      neutralize(){
        init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){};
        renderMobilePrinterSwitcher = function(){}; applyMobilePrinterFilter = function(){};
        attachMobileDayViewSwipe = function(){}; scrollToNow = function(){};
      },
    };`);

  const T = window.__T__;
  T.neutralize();
  T.setEnv({
    printers: [{ id: 5, name: 'Bambulab H2C', color: '#0088cc', favourite: 1, warm_up_mins: 5, cool_down_mins: 15, brand: 'bambulab' }],
    navDate: new Date('2026-07-29T12:00:00'),
  });
  return T;
}

function clickAndCapture(T, block) {
  const opened = [];
  T.setOpenRecorder(id => opened.push(id));
  block.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  return opened;
}

describe("day view — click resolves to the clicked block's own job", () => {
  let T, blocks;

  beforeAll(async () => {
    T = bootDayView();
    await T.renderDay();
    blocks = [...document.querySelectorAll('.job-block')];
  });

  test('renders exactly one block per scheduled job', () => {
    expect(blocks.map(b => Number(b.dataset.jobId)).sort((a, b) => a - b)).toEqual([152, 162]);
  });

  test('the two blocks do not overlap (so hit-testing is unambiguous)', () => {
    const rect = b => {
      const top = parseFloat(b.style.top) || 0;
      const height = parseFloat(b.style.height) || 0;
      return { top, bottom: top + height };
    };
    const a = rect(blocks.find(b => b.dataset.jobId === '152'));
    const c = rect(blocks.find(b => b.dataset.jobId === '162'));
    const [upper, lower] = a.top <= c.top ? [a, c] : [c, a];
    expect(upper.bottom).toBeLessThanOrEqual(lower.top);
  });

  test("clicking each block opens that block's own job — never the neighbour", () => {
    for (const block of blocks) {
      const jobId = Number(block.dataset.jobId);
      expect(clickAndCapture(T, block)).toEqual([jobId]);
    }
  });
});
