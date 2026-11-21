/**
 * @jest-environment jsdom
 *
 * Reschedule dialogs ("Pull forward to…", "Push back to…") must prefill the
 * job's currently planned start (local time), not "now".
 * Drives the real openPullForwardModal / openPushBackModal from public/app.js.
 */
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
    window.__open = { pull: openPullForwardModal, push: openPushBackModal, jobs: jobsCache };`);
  return window.__open;
}

const $ = id => document.getElementById(id);
let api;
beforeAll(() => { api = boot(); });
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
