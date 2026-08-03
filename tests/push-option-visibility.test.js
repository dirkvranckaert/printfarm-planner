/**
 * @jest-environment jsdom
 *
 * Feature A — availability of the four "push/pull toward now" job options.
 *
 * Rules:
 *   - Push back to now: hidden once the job's start is already in the past.
 *   - Pull forward to now: hidden while the job is still scheduled in the future.
 *   - All four: hidden for jobs anchored to a printer (Printing, linked, or
 *     Awaiting Printer) and for unscheduled/queued jobs.
 *
 * Drives the real pushOptionVisibility() out of public/app.js under jsdom.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const NOW = new Date('2026-07-29T12:00:00.000Z').getTime();
const PAST = '2026-07-29T09:00:00.000Z';   // < NOW
const FUTURE = '2026-07-29T15:00:00.000Z'; // > NOW

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
    window.__vis = (job) => pushOptionVisibility(job, ${NOW});`);
  return window.__vis;
}

let vis;
beforeAll(() => { vis = boot(); });

describe('pushOptionVisibility', () => {
  test('future Planned job: push-to-now hidden, pull-to-now shown', () => {
    expect(vis({ status: 'Planned', start: FUTURE })).toEqual({
      pushNow: true, pushTo: true, pullNow: false, pullTo: true,
    });
  });

  test('past Planned job: pull-to-now hidden, push-to-now shown', () => {
    expect(vis({ status: 'Planned', start: PAST })).toEqual({
      pushNow: false, pushTo: true, pullNow: true, pullTo: true,
    });
  });

  test('Printing job: all four hidden', () => {
    expect(vis({ status: 'Printing', start: FUTURE })).toEqual({
      pushNow: false, pushTo: false, pullNow: false, pullTo: false,
    });
  });

  test('Awaiting Printer job: all four hidden', () => {
    expect(vis({ status: 'Awaiting Printer', start: PAST })).toEqual({
      pushNow: false, pushTo: false, pullNow: false, pullTo: false,
    });
  });

  test('job linked to a printer (any status): all four hidden', () => {
    expect(vis({ status: 'Planned', start: FUTURE, linked_printer_id: 3 })).toEqual({
      pushNow: false, pushTo: false, pullNow: false, pullTo: false,
    });
  });

  test('queued (unscheduled) job: all four hidden', () => {
    expect(vis({ status: 'Planned', queued: 1, start: '' })).toEqual({
      pushNow: false, pushTo: false, pullNow: false, pullTo: false,
    });
  });

  test('the DOM applier hides the matching ctx buttons', () => {
    // Sanity that applyPushOptionVisibility drives real elements.
    window.eval(`applyPushOptionVisibility({ status: 'Printing', start: '${FUTURE}' }, 'ctx');`);
    for (const id of ['ctx-push-now', 'ctx-push-to', 'ctx-pull-now', 'ctx-pull-to']) {
      expect(document.getElementById(id).classList.contains('hidden')).toBe(true);
    }
    window.eval(`applyPushOptionVisibility({ status: 'Planned', start: '${PAST}' }, 'ctx');`);
    expect(document.getElementById('ctx-push-now').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('ctx-pull-now').classList.contains('hidden')).toBe(false);
  });
});
