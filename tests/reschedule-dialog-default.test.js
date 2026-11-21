/**
 * @jest-environment jsdom
 *
 * Reschedule dialogs ("Pull forward to…", "Push back to…") must prefill the
 * job's currently planned start (local time), not "now".
 * Drives the real openPullForwardModal / openPushBackModal from public/app.js.
 */
// Force a non-UTC zone so local-vs-UTC regressions cannot hide on UTC runners.
// Must be set before any Date is created (Node re-reads TZ on assignment).
process.env.TZ = 'Europe/Brussels';
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function boot() {
  document.open();
  document.write(HTML);
  document.close();
  window.fetch = () => Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => null });
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };
  window.eval(APP + `
    ;init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){};
    window.__open = { setup: setupListeners, pull: openPullForwardModal, push: openPushBackModal, jobs: jobsCache };`);
  return window.__open;
}

const $ = id => document.getElementById(id);
let api;
beforeAll(() => { api = boot(); api.setup(); });
beforeEach(() => {
  jest.useFakeTimers({ now: new Date(2026, 10, 21, 20, 42, 0) }); // local 21 Nov 2026 20:42
});
afterEach(() => jest.useRealTimers());

describe('reschedule dialog defaults', () => {
  test('pull forward prefills the job planned start, not now', () => {
    api.jobs[1] = { id: 1, start: '2026-11-22T09:00', end: '2026-11-22T11:30' };
    api.pull(1);
    expect($('pullforward-datetime').value).toBe('2026-11-22T09:00');
    // window end defaults to the job's current start
    expect($('pullforward-window-end').value).toBe('2026-11-22T09:00');
  });

  test('pull forward renders a UTC-ISO job start in local time (no UTC slice)', () => {
    const d = new Date(2026, 10, 22, 9, 0);
    api.jobs[2] = { id: 2, start: d.toISOString(), end: d.toISOString() };
    api.pull(2);
    expect($('pullforward-datetime').value).toBe('2026-11-22T09:00');
  });

  test('runs in a non-UTC zone (guards the UTC-ISO test)', () => {
    expect(new Date(2026, 10, 22, 9, 0).getTimezoneOffset()).not.toBe(0);
  });

  test('pull forward falls back to now (+24h window) when job has no start', () => {
    api.jobs[3] = { id: 3, start: '', end: '' };
    api.pull(3);
    expect($('pullforward-datetime').value).toBe('2026-11-21T20:42');
    expect($('pullforward-window-end').value).toBe('2026-11-22T20:42');
  });

  test('push back prefills the job planned start for a future job', () => {
    api.jobs[4] = { id: 4, start: '2026-11-22T09:00', end: '2026-11-22T11:30' };
    api.push(4);
    expect($('pushback-datetime').value).toBe('2026-11-22T09:00');
  });
});

describe('pull forward window mode (start < end)', () => {
  const toggleWindow = on => {
    $('pullforward-window-toggle').checked = on;
    $('pullforward-window-toggle').dispatchEvent(new window.Event('change'));
  };
  const confirm = () => $('pullforward-confirm').click();
  const open = () => !$('pullforward-modal').classList.contains('hidden');
  let calls;
  beforeEach(() => {
    calls = [];
    window.alert = () => {};
    // reshoveMove.js is a separate script tag, not loaded here: record the request it would send.
    window.performTimedMove = async ({ path, body }) => { calls.push({ url: path, body: JSON.stringify(body) }); return { cancelled: true }; };
  });

  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const pullCalls = () => calls.filter(c => /pull-forward/.test(c.url));

  test('enabling window mode on a future job starts the window at now, ends at job start', async () => {
    api.jobs[5] = { id: 5, start: '2026-11-22T09:00', end: '2026-11-22T11:30' };
    api.pull(5);
    toggleWindow(true);
    expect($('pullforward-datetime').value).toBe('2026-11-21T20:42');
    expect($('pullforward-window-end').value).toBe('2026-11-22T09:00');
    confirm();
    expect(open()).toBe(false);
    await flush();
    expect(JSON.parse(pullCalls()[0].body)).toMatchObject({ to: '2026-11-21T20:42', windowEnd: '2026-11-22T09:00' });
  });

  test('window mode on a job whose start is in the past extends the end past start', () => {
    api.jobs[6] = { id: 6, start: '2026-11-20T09:00', end: '2026-11-20T11:30' };
    api.pull(6);
    toggleWindow(true);
    expect($('pullforward-datetime').value).toBe('2026-11-20T09:00');
    expect($('pullforward-window-end').value).toBe('2026-11-21T09:00');
  });

  test('invalid window (end <= start) shows an error, keeps the modal open, sends nothing', () => {
    api.jobs[7] = { id: 7, start: '2026-11-22T09:00', end: '2026-11-22T11:30' };
    api.pull(7);
    toggleWindow(true);
    $('pullforward-datetime').value = '2026-11-22T09:00';
    $('pullforward-window-end').value = '2026-11-22T09:00';
    confirm();
    expect(open()).toBe(true);
    expect($('pullforward-error').classList.contains('hidden')).toBe(false);
    expect($('pullforward-error').textContent).toMatch(/after/);
    expect(calls).toHaveLength(0);
    // editing a field clears the error
    $('pullforward-window-end').value = '2026-11-22T10:00';
    $('pullforward-window-end').dispatchEvent(new window.Event('input'));
    expect($('pullforward-error').classList.contains('hidden')).toBe(true);
  });

  test('empty window end in window mode is rejected', () => {
    api.jobs[8] = { id: 8, start: '2026-11-22T09:00', end: '2026-11-22T11:30' };
    api.pull(8);
    toggleWindow(true);
    $('pullforward-window-end').value = '';
    confirm();
    expect(open()).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('without window mode the forced start submits regardless of the hidden end', async () => {
    api.jobs[9] = { id: 9, start: '2026-11-22T09:00', end: '2026-11-22T11:30' };
    api.pull(9);
    confirm();
    expect(open()).toBe(false);
    await flush();
    const body = JSON.parse(pullCalls()[0].body);
    expect(body.to).toBe('2026-11-22T09:00');
    expect(body.windowEnd).toBeUndefined();
  });
});
