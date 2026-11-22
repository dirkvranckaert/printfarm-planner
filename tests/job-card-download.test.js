/**
 * @jest-environment jsdom
 *
 * Day-view job card: "open in slicer" printer icon for the retained .3mf (#4055).
 *   - shown only when printFile is an uploaded file (no '/'), on the RIGHT of the header row
 *   - a printer SVG button with a >=28px hit area
 *   - clicking it must not open the job modal; it mints a signed URL and navigates to the
 *     slicer scheme (per detected slicer) or falls back to a plain download
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

const JOBS = [
  { id: 1, printerId: 5, name: 'Cube v2', orderNr: 'A1', printFile: 'abc123.3mf',
    start: '2026-07-29T08:00:00.000Z', end: '2026-07-29T10:00:00.000Z', status: 'Planned',
    queued: 0, colors: null, bedType: 'Textured', durationMins: 120 },
  { id: 2, printerId: 5, name: 'No file', printFile: '/some/local/path.3mf',
    start: '2026-07-29T11:00:00.000Z', end: '2026-07-29T13:00:00.000Z', status: 'Planned',
    queued: 0, colors: null, bedType: 'Textured', durationMins: 120 },
];

let slicerLinkResponse;
const fetchCalls = [];

function boot() {
  document.open(); document.write(HTML); document.close();
  window.fetch = (url, opts) => {
    fetchCalls.push([url, opts]);
    if (/\/slicer-link$/.test(url)) return Promise.resolve(slicerLinkResponse);
    return Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => (url === '/api/jobs' ? JOBS : null) });
  };
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };
  window.eval(APP + `
    ;window.__T__ = {
      renderDay, jobDownloadLink, slicerHref, openJobInSlicer,
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
    expect(T.jobDownloadLink({ id: 1, name: 'x' })).toBe('');
    expect(T.jobDownloadLink({ id: 1, name: 'x', printFile: '' })).toBe('');
    expect(T.jobDownloadLink({ id: 1, name: 'x', printFile: '/tmp/a.3mf' })).toBe('');
  });

  test('printer-icon button carrying the job id, no raw upload href, not the old box emoji', () => {
    const html = T.jobDownloadLink({ id: 7, name: 'My Cube/1', orderNr: 'A1', printFile: 'abc.3mf' });
    expect(html).toContain('<button');
    expect(html).toContain('data-job-id="7"');
    expect(html).toContain('<svg');
    expect(html).not.toContain('📦');
    expect(html).not.toContain('/api/uploads/');
    expect(html).toContain('A1_My_Cube_1.3mf'); // plain-download hint in the title
  });

  test('escapes HTML in the name', () => {
    expect(T.jobDownloadLink({ id: 1, name: '<b>', printFile: 'a.3mf' })).not.toContain('<b>');
  });

  test('subtle: 16px glyph, muted by default, full on card hover, tint on icon hover, no box', () => {
    expect(T.jobDownloadLink({ id: 1, name: 'x', printFile: 'a.3mf' })).toMatch(/width="16" height="16"/);
    const rule = /\.job-dl\s*\{([^}]*)\}/.exec(CSS)[1];
    expect(rule).toMatch(/opacity:\s*\.45/);
    expect(rule).toMatch(/background:\s*none/);
    expect(rule).toMatch(/border:\s*0/);
    expect(CSS).toMatch(/\.job-block:hover \.job-dl\s*\{\s*opacity:\s*1/);
    expect(CSS).toMatch(/\.job-dl:hover\s*\{[^}]*background:\s*rgba/);
  });

  test('hit area is at least 28px', () => {
    const rule = /\.job-dl\s*\{([^}]*)\}/.exec(CSS)[1];
    expect(rule).toMatch(/width:\s*28px/);
    expect(rule).toMatch(/height:\s*28px/);
  });
});

describe('slicerHref', () => {
  const T = boot();
  const url = 'https://planner.test/api/dl/tok.sig/A1_Cube.3mf';
  const enc = encodeURIComponent(url);

  test('bambustudio: macOS registers bambustudioopen://, elsewhere bambustudio://open?file=', () => {
    expect(T.slicerHref('bambustudio', url, true)).toBe(`bambustudioopen://${enc}`);
    expect(T.slicerHref('bambustudio', url, false)).toBe(`bambustudio://open?file=${enc}`);
  });
  test('orcaslicer', () => {
    expect(T.slicerHref('orcaslicer', url, true)).toBe(`orcaslicer://open?file=${enc}`);
    expect(T.slicerHref('orcaslicer', url, false)).toBe(`orcaslicer://open?file=${enc}`);
  });
  test('prusaslicer (host allow-list refuses us), unknown, null -> plain download', () => {
    expect(T.slicerHref('prusaslicer', url, true)).toBeNull();
    expect(T.slicerHref('cura', url, true)).toBeNull();
    expect(T.slicerHref(null, url, true)).toBeNull();
  });
});

describe('day view card', () => {
  let T;
  beforeAll(async () => { T = boot(); await T.renderDay(); });

  test('icon only on the job with an uploaded file', () => {
    expect(document.querySelector('.job-block[data-job-id="1"] button.job-dl')).not.toBeNull();
    expect(document.querySelector('.job-block[data-job-id="2"] button.job-dl')).toBeNull();
  });

  test('icon sits after the status badge (right side of the header row)', () => {
    const row = document.querySelector('.job-block[data-job-id="1"] > div');
    const kids = [...row.children];
    expect(kids.indexOf(row.querySelector('.job-dl'))).toBeGreaterThan(kids.indexOf(row.querySelector('.job-status-badge')));
    expect(kids[kids.length - 1]).toBe(row.querySelector('.job-dl'));
  });

  const click = (el, init = {}) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
  const flush = () => new Promise(r => setTimeout(r, 20));

  test('clicking the icon does not open the job; clicking the card does', async () => {
    slicerLinkResponse = { ok: false, status: 404, json: async () => ({}) };
    window.alert = () => {};
    const opened = [];
    T.setOpenRecorder(id => opened.push(id));
    const block = document.querySelector('.job-block[data-job-id="1"]');
    click(block.querySelector('.job-dl'));
    await flush();
    expect(opened).toEqual([]);
    click(block);
    expect(opened).toEqual([1]);
  });

  test('click POSTs slicer-link for that job', async () => {
    fetchCalls.length = 0;
    slicerLinkResponse = { ok: false, status: 404, json: async () => ({}) };
    window.alert = () => {};
    click(document.querySelector('.job-block[data-job-id="1"] .job-dl'));
    await flush();
    expect(fetchCalls.find(c => /slicer-link/.test(c[0]))).toEqual(['/api/jobs/1/slicer-link', { method: 'POST' }]);
  });

  test('401 shows a session-expired message, not "No 3MF"', async () => {
    slicerLinkResponse = { ok: false, status: 401, json: async () => ({}) };
    const msgs = [];
    window.alert = m => msgs.push(m);
    click(document.querySelector('.job-block[data-job-id="1"] .job-dl'));
    await flush();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/session expired/i);
  });

  test('unknown slicer falls back to a plain download link click (no scheme navigation)', async () => {
    slicerLinkResponse = { ok: true, status: 200, json: async () => ({ slicer: null, filename: 'A1_Cube_v2.3mf', path: '/api/dl/t.s/A1_Cube_v2.3mf' }) };
    const clicked = [];
    const orig = window.HTMLAnchorElement.prototype.click;
    window.HTMLAnchorElement.prototype.click = function () { clicked.push([this.getAttribute('href'), this.getAttribute('download')]); };
    click(document.querySelector('.job-block[data-job-id="1"] .job-dl'));
    await flush();
    window.HTMLAnchorElement.prototype.click = orig;
    expect(clicked).toHaveLength(1);
    expect(clicked[0][0]).toMatch(/\/api\/dl\/t\.s\/A1_Cube_v2\.3mf$/);
    expect(clicked[0][1]).toBe('A1_Cube_v2.3mf');
  });

  test('Alt-click forces plain download even for a known slicer', async () => {
    slicerLinkResponse = { ok: true, status: 200, json: async () => ({ slicer: 'orcaslicer', filename: 'f.3mf', path: '/api/dl/t.s/f.3mf' }) };
    const clicked = [];
    const orig = window.HTMLAnchorElement.prototype.click;
    window.HTMLAnchorElement.prototype.click = function () { clicked.push(this.getAttribute('href')); };
    click(document.querySelector('.job-block[data-job-id="1"] .job-dl'), { altKey: true });
    await flush();
    window.HTMLAnchorElement.prototype.click = orig;
    expect(clicked).toHaveLength(1);
  });
});
