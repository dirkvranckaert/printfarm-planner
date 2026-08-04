/**
 * @jest-environment jsdom
 *
 * Day-view job card shows the job's project label (resolved server-side into the
 * /api/jobs payload as `job.project`), styled like the customer line. The line
 * is present only when the job HAS a project, and the free-text label is
 * HTML-escaped (same treatment as customer / orderNr).
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const RESHOVE = fs.readFileSync(path.join(__dirname, '..', 'public', 'reshoveMove.js'), 'utf8');

const NAV = new Date(); NAV.setHours(0, 0, 0, 0);

const aStart = new Date(NAV); aStart.setHours(2, 0, 0, 0);
const aEnd   = new Date(NAV); aEnd.setHours(3, 0, 0, 0);
const bStart = new Date(NAV); bStart.setHours(5, 0, 0, 0);
const bEnd   = new Date(NAV); bEnd.setHours(6, 0, 0, 0);

// Job A carries a project (with an HTML metacharacter to prove escaping);
// job B has no project (project resolved to null in the payload).
const JOBS = [
  { id: 901, printerId: 5, name: 'With project', customerName: 'X', orderNr: 'S1',
    start: aStart.toISOString(), end: aEnd.toISOString(), status: 'Planned',
    queued: 0, linked_printer_id: null, colors: null, bedType: null,
    durationMins: 60, cool_down_mins: 0, project: 'Rocket <Kit>' },
  { id: 902, printerId: 5, name: 'No project', customerName: 'Y', orderNr: 'S2',
    start: bStart.toISOString(), end: bEnd.toISOString(), status: 'Planned',
    queued: 0, linked_printer_id: null, colors: null, bedType: null,
    durationMins: 60, cool_down_mins: 0, project: null },
];

function boot() {
  document.open();
  document.write(HTML);
  document.close();

  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return this.id === 'day-scroll' ? 2880 : 0; },
  });

  window.fetch = (url, opts) => {
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
      neutralize(){
        init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){};
        renderMobilePrinterSwitcher = function(){}; applyMobilePrinterFilter = function(){};
        attachMobileDayViewSwipe = function(){}; scrollToNow = function(){};
        renderCalendar = async function(){};
      },
      setEnv(o){ if(o.printers) printers = o.printers; if(o.navDate) navDate = o.navDate; },
    };`);

  const T = window.__T__;
  T.neutralize();
  T.setEnv({
    printers: [{ id: 5, name: 'Bambulab H2C', color: '#0088cc', favourite: 1,
      warm_up_mins: 0, cool_down_mins: 0, brand: 'bambulab' }],
    navDate: NAV,
  });
  return T;
}

describe('day-view card shows the job project label', () => {
  let T;
  beforeAll(async () => {
    T = boot();
    await T.renderDay();
  });

  test('a job WITH a project renders a .job-block-project line with the label', () => {
    const el = document.querySelector('.job-block[data-job-id="901"] .job-block-project');
    expect(el).not.toBeNull();
    expect(el.textContent).toBe('Rocket <Kit>');
  });

  test('the project label is HTML-escaped', () => {
    const el = document.querySelector('.job-block[data-job-id="901"] .job-block-project');
    expect(el.innerHTML).toBe('Rocket &lt;Kit&gt;');
  });

  test('a job WITHOUT a project renders no .job-block-project line', () => {
    const el = document.querySelector('.job-block[data-job-id="902"] .job-block-project');
    expect(el).toBeNull();
  });
});
