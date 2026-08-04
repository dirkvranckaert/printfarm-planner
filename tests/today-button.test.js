/**
 * @jest-environment jsdom
 *
 * "Today" button state: it marks whether today is already in view.
 *   - today NOT in view  → default clickable state (jumps to today).
 *   - today IS in view    → .is-today class + disabled (nothing to jump to).
 * Re-evaluated every render and on the 1-min tick, so crossing midnight with the
 * view open flips it back to clickable (covered here by moving navDate off today).
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const midnight = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays  = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function boot() {
  document.open(); document.write(HTML); document.close();
  window.fetch = () => Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => null });
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };

  window.eval(APP + `
    ;window.__T__ = {
      isTodayInView, updateTodayButton,
      setEnv(o){ if(o.view) view = o.view; if(o.navDate) navDate = o.navDate; },
      neutralize(){ init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){};
        renderMobilePrinterSwitcher = function(){}; scrollToNow = function(){}; renderCalendar = async function(){}; },
    };`);
  const T = window.__T__; T.neutralize();
  return T;
}

const T = boot();
const btn = () => document.getElementById('btn-today');
const check = (view, navDate) => { T.setEnv({ view, navDate }); return T.isTodayInView(); };

describe('isTodayInView per view', () => {
  const today = midnight();

  test('day: navDate === today → true; other day → false', () => {
    expect(check('day', midnight())).toBe(true);
    expect(check('day', addDays(today, 3))).toBe(false);
    expect(check('day', addDays(today, -1))).toBe(false);
  });

  test('week: today inside the shown week → true; a week away → false', () => {
    expect(check('week', today)).toBe(true);
    expect(check('week', addDays(today, 14))).toBe(false);
  });

  test('month: same month → true; another month → false', () => {
    expect(check('month', today)).toBe(true);
    expect(check('month', new Date(today.getFullYear(), today.getMonth() + 2, 15))).toBe(false);
  });

  test('upcoming: always anchored at today → true', () => {
    expect(check('upcoming', addDays(today, 30))).toBe(true);
  });
});

describe('updateTodayButton toggles class + disabled', () => {
  test('today in view → .is-today + disabled', () => {
    T.setEnv({ view: 'day', navDate: midnight() });
    T.updateTodayButton();
    expect(btn().classList.contains('is-today')).toBe(true);
    expect(btn().disabled).toBe(true);
  });

  test('today NOT in view → no .is-today, enabled (clickable)', () => {
    T.setEnv({ view: 'day', navDate: addDays(midnight(), 5) });
    T.updateTodayButton();
    expect(btn().classList.contains('is-today')).toBe(false);
    expect(btn().disabled).toBe(false);
  });

  test('moving navDate off today (e.g. midnight crossing) re-enables the button', () => {
    T.setEnv({ view: 'day', navDate: midnight() });
    T.updateTodayButton();
    expect(btn().disabled).toBe(true);
    // Simulate "today" advancing past the shown day: navDate now trails today.
    T.setEnv({ view: 'day', navDate: addDays(midnight(), -1) });
    T.updateTodayButton();
    expect(btn().disabled).toBe(false);
  });
});
