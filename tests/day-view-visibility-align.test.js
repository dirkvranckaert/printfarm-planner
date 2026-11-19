/**
 * @jest-environment jsdom
 *
 * Printer visibility (favourite) consistency in the day view:
 *   1. The live status cards panel only lists favourite printers (same setting
 *      that drives the calendar columns).
 *   2. Header and body share one column template: the gear button is out of
 *      flow (no extra flex slot) and the header reserves the body's vertical
 *      scrollbar width via --day-sbw.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS  = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

const mk = (id, name, favourite) => ({ id, name, color: '#0088cc', favourite, brand: 'bambulab', bambu_serial: `S${id}`, warm_up_mins: 0, cool_down_mins: 15 });
const PRINTERS = [mk(1, 'Bambulab P1S', 1), mk(2, 'Bambulab H2C', 1), mk(3, 'Bambulab A1 Mini', 0)];

function boot() {
  document.open(); document.write(HTML); document.close();
  window.fetch = () => Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => [] });
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };
  window.eval(APP + `
    ;window.__T__ = {
      renderStatusPanel, renderTopbarStatus, renderDay, syncDayHeaderScrollbar,
      setEnv(o){ if(o.printers) printers = o.printers; if(o.navDate) navDate = o.navDate; closures = []; },
      neutralize(){
        init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){};
        renderMobilePrinterSwitcher = function(){}; applyMobilePrinterFilter = function(){};
        attachMobileDayViewSwipe = function(){}; scrollToNow = function(){}; attachDayEvents = function(){};
      },
    };`);
  const T = window.__T__; T.neutralize();
  T.setEnv({ printers: PRINTERS, navDate: new Date('2026-11-19T12:00:00') });
  return T;
}

describe('status cards panel respects printer visibility', () => {
  test('hidden printer gets no card (explicit list and default list)', () => {
    const T = boot();
    T.renderStatusPanel(PRINTERS);
    let names = [...document.querySelectorAll('#printer-status-panel .ps-card-name')].map(e => e.textContent);
    expect(names).toEqual(['Bambulab P1S', 'Bambulab H2C']);

    T.renderStatusPanel();
    names = [...document.querySelectorAll('#printer-status-panel .ps-card-name')].map(e => e.textContent);
    expect(names).not.toContain('Bambulab A1 Mini');
  });

  test('all visible -> all cards', () => {
    const T = boot();
    T.setEnv({ printers: PRINTERS.map(p => ({ ...p, favourite: 1 })) });
    T.renderStatusPanel(PRINTERS.map(p => ({ ...p, favourite: 1 })));
    expect(document.querySelectorAll('#printer-status-panel .ps-card').length).toBe(3);
  });

  test('no visible printers -> status button hidden', () => {
    const T = boot();
    T.renderStatusPanel(PRINTERS.map(p => ({ ...p, favourite: 0 })));
    expect(document.getElementById('btn-printer-status').classList.contains('hidden')).toBe(true);
  });
});

describe('day header / body share one column template', () => {
  test('gear button is out of flow in CSS', () => {
    const rule = /\.day-settings-btn\s*\{[^}]*\}/.exec(CSS)[0];
    expect(rule).toMatch(/position:\s*absolute/);
  });

  test.each([[3, 0], [4, 1]])('header reserves body scrollbar width (%i printers)', async (n) => {
    const T = boot();
    T.setEnv({ printers: PRINTERS.map((p, i) => ({ ...p, favourite: i < n ? 1 : 0 })).concat([mk(4, 'H3C', 1)]).slice(0, n) });
    await T.renderDay();
    const scroll = document.getElementById('day-scroll');
    Object.defineProperty(scroll, 'offsetWidth', { configurable: true, value: 1000 });
    Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 985 });
    T.syncDayHeaderScrollbar();
    const header = document.querySelector('.day-view-header');
    expect(header.style.getPropertyValue('--day-sbw')).toBe('15px');
    expect(header.querySelectorAll('.day-printer-header').length).toBe(document.querySelectorAll('.day-printer-col').length);
  });

  test('overlay scrollbars -> 0px', async () => {
    const T = boot();
    await T.renderDay();
    T.syncDayHeaderScrollbar();
    expect(document.querySelector('.day-view-header').style.getPropertyValue('--day-sbw')).toBe('0px');
  });
});
