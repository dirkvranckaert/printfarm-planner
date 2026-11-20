/**
 * @jest-environment jsdom
 *
 * Status cards panel: one equal-width card per visible printer, filling the
 * row, starting at the day-column edge, wrapping (not squashing) when narrow.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS  = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

const mk = (id, favourite) => ({ id, name: `P${id}`, color: '#08c', favourite, brand: 'bambulab', bambu_serial: `S${id}` });

function boot() {
  document.open(); document.write(HTML); document.close();
  window.fetch = () => Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => [] });
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };
  window.countAttentionJobs = () => 0;
  window.eval(APP + `;window.__T__ = { renderStatusPanel, setEnv(o){ printers = o.printers; },
    neutralize(){ init = function(){}; renderCalendar = async function(){}; } };`);
  window.__T__.neutralize();
  return window.__T__;
}

const cols = () => document.getElementById('printer-status-panel').style.getPropertyValue('--ps-cols');

describe('--ps-cols follows the visible printer count', () => {
  test.each([[1], [3], [4], [6]])('%i visible printers -> that many cards and --ps-cols', (n) => {
    const T = boot();
    const ps = Array.from({ length: n }, (_, i) => mk(i + 1, 1)).concat([mk(99, 0)]);
    T.setEnv({ printers: ps });
    T.renderStatusPanel(ps);
    expect(document.querySelectorAll('#printer-status-panel .ps-card').length).toBe(n);
    expect(cols()).toBe(String(n));
  });
});

describe('panel CSS', () => {
  const block = /@media \(min-width: 761px\)\s*\{\s*\.printer-status-panel\s*\{[^}]*\}\s*\}/.exec(CSS);

  test('desktop rule exists, is count-driven and not a fixed 3/4-column grid', () => {
    expect(block).not.toBeNull();
    expect(block[0]).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(max\(220px,\s*calc\(100%\s*\/\s*var\(--ps-cols/);
    expect(CSS).not.toMatch(/\.printer-status-panel\s*\{\s*grid-template-columns:\s*repeat\(4,\s*1fr\)/);
  });

  test('panel starts at the day-column edge (time gutter)', () => {
    expect(block[0]).toMatch(/padding-left:\s*var\(--time-col-w\)/);
  });

  test('minimum card width keeps AMS grid intact (>= 220px)', () => {
    const min = Number(/max\((\d+)px/.exec(block[0])[1]);
    expect(min).toBeGreaterThanOrEqual(220);
  });

  test('phones keep the single-column override', () => {
    expect(CSS).toMatch(/\.printer-status-panel\s*\{\s*grid-template-columns:\s*1fr\s*!important/);
  });
});
