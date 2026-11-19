/**
 * @jest-environment jsdom
 *
 * Printer visibility (`favourite`, "Show in planner") applies to every view,
 * and the day-view header stays aligned with the body columns:
 *   1. status cards panel, week view and today overview list only visible printers;
 *   2. hiding the last visible printer closes the status panel / hides its button;
 *   3. togglePrinterFavourite refreshes the status UI immediately;
 *   4. header reserves the body's vertical-scrollbar width (--day-sbw) automatically
 *      after renderDay AND whenever the scroll geometry later changes
 *      (ResizeObserver), appearing and disappearing.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS  = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

const mk = (id, name, favourite) => ({ id, name, color: '#0088cc', favourite, brand: 'bambulab', bambu_serial: `S${id}`, warm_up_mins: 0, cool_down_mins: 15 });
const PRINTERS = () => [mk(1, 'Bambulab P1S', 1), mk(2, 'Bambulab H2C', 1), mk(3, 'Bambulab A1 Mini', 0)];

let observers;
let fetchData;

function boot() {
  observers = [];
  fetchData = { '/api/jobs': [], '/api/closures': [] };
  document.open(); document.write(HTML); document.close();
  window.fetch = (url, opts) => {
    const data = url in fetchData ? fetchData[url] : [];
    return Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => data });
  };
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };
  window.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(t) { this.targets.push(t); }
    disconnect() { this.disconnected = true; }
  };
  window.countAttentionJobs = () => 0;
  window.eval(APP + `
    ;window.__T__ = {
      renderStatusPanel, renderTopbarStatus, toggleStatusPanel, togglePrinterFavourite,
      renderDay, renderWeek, renderTodayPanel,
      setEnv(o){ if(o.printers) printers = o.printers; if(o.navDate) navDate = o.navDate; if('showTodayPanel' in o) showTodayPanel = o.showTodayPanel; closures = []; },
      neutralize(){
        init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){};
        renderMobilePrinterSwitcher = function(){}; applyMobilePrinterFilter = function(){};
        attachMobileDayViewSwipe = function(){}; scrollToNow = function(){}; attachDayEvents = function(){};
        attachWeekEvents = typeof attachWeekEvents === 'function' ? function(){} : undefined;
      },
    };`);
  const T = window.__T__; T.neutralize();
  T.setEnv({ printers: PRINTERS(), navDate: new Date('2026-11-19T12:00:00') });
  return T;
}

// jsdom has no layout: fake the scrollbar via offsetWidth - clientWidth on #day-scroll.
let sbw = 0;
function fakeScrollbar() {
  sbw = 0;
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.id === 'day-scroll' ? 1000 : 0; } });
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.id === 'day-scroll' ? 1000 - sbw : 0; } });
}
const sbwVar = () => document.querySelector('.day-view-header').style.getPropertyValue('--day-sbw');
const cardNames = () => [...document.querySelectorAll('#printer-status-panel .ps-card-name')].map(e => e.textContent);

describe('status cards panel', () => {
  test('hidden printer gets no card (explicit and default list)', () => {
    const T = boot();
    T.renderStatusPanel(PRINTERS());
    expect(cardNames()).toEqual(['Bambulab P1S', 'Bambulab H2C']);
    T.renderStatusPanel();
    expect(cardNames()).not.toContain('Bambulab A1 Mini');
  });

  test('all visible -> all cards', () => {
    const T = boot();
    const all = PRINTERS().map(p => ({ ...p, favourite: 1 }));
    T.renderStatusPanel(all);
    expect(cardNames().length).toBe(3);
  });

  test('last visible printer hidden -> button hidden, open panel closed, never reopens empty', () => {
    const T = boot();
    const none = PRINTERS().map(p => ({ ...p, favourite: 0 }));
    const panel = document.getElementById('printer-status-panel');
    const btn = document.getElementById('btn-printer-status');
    T.renderStatusPanel(PRINTERS());
    panel.classList.remove('hidden');
    T.setEnv({ printers: none });
    T.renderStatusPanel(none);
    expect(btn.classList.contains('hidden')).toBe(true);
    expect(panel.classList.contains('hidden')).toBe(true);
    T.toggleStatusPanel();
    expect(panel.classList.contains('hidden')).toBe(true);
  });

  test('togglePrinterFavourite refreshes status UI right away', async () => {
    const T = boot();
    const visible = [mk(1, 'Bambulab P1S', 1)];
    T.setEnv({ printers: visible });
    const panel = document.getElementById('printer-status-panel');
    const btn = document.getElementById('btn-printer-status');
    T.renderStatusPanel(visible);
    panel.classList.remove('hidden');
    expect(btn.classList.contains('hidden')).toBe(false);
    // server now reports the printer as hidden
    fetchData['/api/printers'] = [mk(1, 'Bambulab P1S', 0)];
    await T.togglePrinterFavourite(1, 0);
    expect(btn.classList.contains('hidden')).toBe(true);
    expect(panel.classList.contains('hidden')).toBe(true);
    expect(cardNames()).toEqual([]);
  });
});

describe('week view and today overview', () => {
  test('week view rows only for visible printers', async () => {
    const T = boot();
    await T.renderWeek();
    const labels = [...document.querySelectorAll('.week-printer-label')].map(e => e.textContent.trim());
    expect(labels).toEqual(['Bambulab P1S', 'Bambulab H2C']);
  });

  test('week view with no visible printers shows the empty state', async () => {
    const T = boot();
    T.setEnv({ printers: PRINTERS().map(p => ({ ...p, favourite: 0 })) });
    await T.renderWeek();
    expect(document.querySelector('.week-printer-label')).toBeNull();
    expect(document.querySelector('#calendar-container .empty-state')).not.toBeNull();
  });

  test('today overview utilisation rows only for visible printers', async () => {
    const T = boot();
    T.setEnv({ showTodayPanel: true });
    await T.renderTodayPanel();
    const html = document.getElementById('today-panel').innerHTML;
    expect(html).toContain('Bambulab P1S');
    expect(html).toContain('Bambulab H2C');
    expect(html).not.toContain('A1 Mini');
  });
});

describe('day header / body column template', () => {
  test('CSS: header consumes --day-sbw, gear is out of flow and offset by it', () => {
    const header = /\.day-view-header\s*\{[^}]*\}/.exec(CSS)[0];
    expect(header).toMatch(/padding-right:\s*var\(--day-sbw/);
    const gear = /\.day-settings-btn\s*\{[^}]*\}/.exec(CSS)[0];
    expect(gear).toMatch(/position:\s*absolute/);
    expect(gear).toMatch(/right:\s*calc\(var\(--day-sbw/);
  });

  test('renderDay syncs automatically (no manual call)', async () => {
    const T = boot(); fakeScrollbar(); sbw = 15;
    await T.renderDay();
    expect(sbwVar()).toBe('15px');
  });

  test('all-visible set: header cell count equals body column count', async () => {
    const T = boot(); fakeScrollbar();
    T.setEnv({ printers: PRINTERS().map(p => ({ ...p, favourite: 1 })) });
    await T.renderDay();
    expect(document.querySelectorAll('.day-printer-header').length).toBe(3);
    expect(document.querySelectorAll('.day-printer-col').length).toBe(3);
  });

  test('follows scrollbar appearing and disappearing after render', async () => {
    const T = boot(); fakeScrollbar(); sbw = 0;
    await T.renderDay();
    expect(sbwVar()).toBe('0px');
    const obs = observers.filter(o => !o.disconnected).pop();
    expect(obs.targets.some(t => t.id === 'day-scroll')).toBe(true);
    expect(obs.targets.some(t => t.classList.contains('day-view-body'))).toBe(true);

    sbw = 15;               // e.g. expandDayBodyForDrag grew the body -> scrollbar appears
    obs.cb();
    expect(sbwVar()).toBe('15px');

    sbw = 0;                // invalid drop / panel toggle -> scrollbar disappears
    obs.cb();
    expect(sbwVar()).toBe('0px');
  });

  test('re-render replaces the observer (no leak)', async () => {
    const T = boot(); fakeScrollbar();
    await T.renderDay();
    const first = observers.filter(o => !o.disconnected).pop();
    await T.renderDay();
    expect(first.disconnected).toBe(true);
    expect(observers.filter(o => !o.disconnected).length).toBe(1);
  });
});
