/**
 * @jest-environment jsdom
 *
 * Day-view job card: download icon for the retained .3mf (no need to open the job).
 *   - shown only when printFile is an uploaded file (no '/')
 *   - href stays on the authenticated /api/uploads route, filename matches the job dialog
 *   - clicking it must not open the job modal
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const JOBS = [
  { id: 1, printerId: 5, name: 'Cube v2', orderNr: 'A1', printFile: 'abc123.3mf',
    start: '2026-07-29T08:00:00.000Z', end: '2026-07-29T10:00:00.000Z', status: 'Planned',
    queued: 0, colors: null, bedType: 'Textured', durationMins: 120 },
  { id: 2, printerId: 5, name: 'No file', printFile: '/some/local/path.3mf',
    start: '2026-07-29T11:00:00.000Z', end: '2026-07-29T13:00:00.000Z', status: 'Planned',
    queued: 0, colors: null, bedType: 'Textured', durationMins: 120 },
];

function boot() {
  document.open(); document.write(HTML); document.close();
  window.fetch = (url) => Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => (url === '/api/jobs' ? JOBS : null) });
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };
  window.eval(APP + `
    ;window.__T__ = {
      renderDay, jobDownloadLink,
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

describe('jobDownloadLink', () => {
  const T = boot();

  test('empty when no uploaded file', () => {
    expect(T.jobDownloadLink({ name: 'x' })).toBe('');
    expect(T.jobDownloadLink({ name: 'x', printFile: '' })).toBe('');
    expect(T.jobDownloadLink({ name: 'x', printFile: '/tmp/a.3mf' })).toBe('');
  });

  test('authenticated upload route + sanitised filename with order prefix', () => {
    const html = T.jobDownloadLink({ name: 'My Cube/1', orderNr: 'A1', printFile: 'abc.3mf' });
    expect(html).toContain('href="/api/uploads/abc.3mf"');
    expect(html).toContain('download="A1_My_Cube_1.3mf"');
  });

  test('escapes HTML in the name', () => {
    expect(T.jobDownloadLink({ name: '<b>', printFile: 'a.3mf' })).not.toContain('<b>');
  });
});

describe('day view card', () => {
  let T;
  beforeAll(async () => { T = boot(); await T.renderDay(); });

  test('icon only on the job with an uploaded file', () => {
    const b1 = document.querySelector('.job-block[data-job-id="1"]');
    const b2 = document.querySelector('.job-block[data-job-id="2"]');
    expect(b1.querySelector('a.job-dl').getAttribute('href')).toBe('/api/uploads/abc123.3mf');
    expect(b2.querySelector('a.job-dl')).toBeNull();
  });

  test('clicking the icon does not open the job; clicking the card does', () => {
    const opened = [];
    T.setOpenRecorder(id => opened.push(id));
    const block = document.querySelector('.job-block[data-job-id="1"]');
    const link = block.querySelector('a.job-dl');
    link.addEventListener('click', e => e.preventDefault()); // jsdom: no navigation
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(opened).toEqual([]);
    block.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(opened).toEqual([1]);
  });
});
