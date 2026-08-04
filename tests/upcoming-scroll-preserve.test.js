/**
 * @jest-environment jsdom
 *
 * Regression guard: background SSE re-renders of the Upcoming view must not
 * yank the user's scroll back to the top.
 *
 * The bug: renderUpcoming() ended with an unconditional `container.innerHTML = h`.
 * Every SSE frame (renderCalendar → renderUpcoming) fires every few seconds and
 * rebuilt the DOM, destroying the .upcoming-view scroll container and resetting
 * scrollTop to 0 — even when nothing had changed.
 *
 * The fix, asserted here:
 *   1. Unchanged payload → renderUpcoming skips the innerHTML swap entirely
 *      (same .upcoming-view node survives, scrollTop untouched).
 *   2. Changed payload → the list updates AND scrollTop is restored, not reset.
 *
 * jsdom does no layout, so real scroll height is unavailable; we stub a non-zero
 * scrollTop on the scroll container and assert it survives the render.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const DAY = 24 * 60 * 60 * 1000;

function job(id, name, offsetDays) {
  const start = new Date(); start.setHours(10, 0, 0, 0); start.setTime(start.getTime() + offsetDays * DAY);
  const end   = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    id, printerId: 5, name, customerName: 'X', orderNr: 'O' + id,
    start: start.toISOString(), end: end.toISOString(), status: 'Planned',
    queued: 0, linked_printer_id: null, colors: null, bedType: 'Textured', durationMins: 60,
  };
}

// Mutable payload the fetch mock serves for /api/jobs — tests swap it to
// simulate an unchanged vs. changed background refresh.
let JOBS = [job(901, 'Alpha', 1), job(902, 'Beta', 2)];

function boot() {
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
      renderUpcoming, renderWeek, renderMonth,
      setEnv(o){ if(o.printers) printers = o.printers; if(o.closures) closures = o.closures; if(o.navDate) navDate = o.navDate; },
      neutralize(){ init = function(){}; addLongPress = function(){}; },
    };`);

  const T = window.__T__;
  T.neutralize();
  const nav = new Date(); nav.setHours(0, 0, 0, 0);
  T.setEnv({
    printers: [{ id: 5, name: 'Bambulab H2C', color: '#0088cc', brand: 'bambulab' }],
    closures: [],
    navDate: nav,
  });
  return T;
}

describe('Upcoming view — scroll survives background refresh', () => {
  let T;

  beforeEach(async () => {
    JOBS = [job(901, 'Alpha', 1), job(902, 'Beta', 2)];
    T = boot();
    await T.renderUpcoming();
  });

  test('unchanged payload skips the DOM rebuild (same node, scrollTop kept)', async () => {
    const before = document.querySelector('.upcoming-view');
    expect(before).not.toBeNull();
    before.scrollTop = 240; // user scrolled down while editing

    await T.renderUpcoming(); // background SSE re-render, identical data

    const after = document.querySelector('.upcoming-view');
    expect(after).toBe(before);          // same node → innerHTML was never rebuilt
    expect(after.scrollTop).toBe(240);   // scroll position untouched
  });

  test('changed payload updates the list AND restores scrollTop', async () => {
    const before = document.querySelector('.upcoming-view');
    before.scrollTop = 240;
    expect(document.querySelectorAll('.upcoming-job-row').length).toBe(2);

    JOBS = [job(901, 'Alpha', 1), job(902, 'Beta', 2), job(903, 'Gamma', 3)];
    await T.renderUpcoming();

    const after = document.querySelector('.upcoming-view');
    expect(after).not.toBe(before);      // node was rebuilt (real change)
    expect(document.querySelectorAll('.upcoming-job-row').length).toBe(3); // list updated
    expect(after.scrollTop).toBe(240);   // but scroll was restored, not reset to 0
  });
});

// Week + Month carry the identical SSE-poll scroll-reset bug (renderWeek /
// renderMonth ended with a plain innerHTML swap). Same fix, same assertions.
// Jobs sit on today (offset 0) so they land in the current week and month grid.
describe('Week view — scroll survives background refresh', () => {
  let T;

  beforeEach(async () => {
    JOBS = [job(801, 'Alpha', 0), job(802, 'Beta', 0)];
    T = boot();
    await T.renderWeek();
  });

  test('unchanged payload skips the DOM rebuild (same node, scrollTop kept)', async () => {
    const before = document.querySelector('.week-view');
    expect(before).not.toBeNull();
    before.scrollTop = 240;

    await T.renderWeek();

    const after = document.querySelector('.week-view');
    expect(after).toBe(before);
    expect(after.scrollTop).toBe(240);
  });

  test('changed payload updates the grid AND restores scrollTop', async () => {
    const before = document.querySelector('.week-view');
    before.scrollTop = 240;
    expect(document.querySelectorAll('.week-job-chip').length).toBe(2);

    JOBS = [job(801, 'Alpha', 0), job(802, 'Beta', 0), job(803, 'Gamma', 0)];
    await T.renderWeek();

    const after = document.querySelector('.week-view');
    expect(after).not.toBe(before);
    expect(document.querySelectorAll('.week-job-chip').length).toBe(3);
    expect(after.scrollTop).toBe(240);
  });
});

describe('Month view — scroll survives background refresh', () => {
  let T;

  beforeEach(async () => {
    JOBS = [job(701, 'Alpha', 0), job(702, 'Beta', 0)];
    T = boot();
    await T.renderMonth();
  });

  test('unchanged payload skips the DOM rebuild (same node, scrollTop kept)', async () => {
    const before = document.querySelector('.month-view');
    expect(before).not.toBeNull();
    before.scrollTop = 240;

    await T.renderMonth();

    const after = document.querySelector('.month-view');
    expect(after).toBe(before);
    expect(after.scrollTop).toBe(240);
  });

  test('changed payload updates the grid AND restores scrollTop', async () => {
    const before = document.querySelector('.month-view');
    before.scrollTop = 240;
    expect(document.querySelectorAll('.month-job-chip').length).toBe(2);

    JOBS = [job(701, 'Alpha', 0), job(702, 'Beta', 0), job(703, 'Gamma', 0)];
    await T.renderMonth();

    const after = document.querySelector('.month-view');
    expect(after).not.toBe(before);
    expect(document.querySelectorAll('.month-job-chip').length).toBe(3);
    expect(after.scrollTop).toBe(240);
  });
});
