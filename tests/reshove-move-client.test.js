/**
 * @jest-environment jsdom
 *
 * Client-side confirm/retry flow for timed moves (pushBackJob / pullForwardJob),
 * exercising the real app.js functions + reshoveMove.js in jsdom. Guards:
 *   - a needsReshove response opens the confirm dialog and, on confirm, retries
 *     with reshove:true;
 *   - a to-now retry pins `to` to the server's returned target (so the anchor
 *     doesn't drift to a recomputed later "now");
 *   - a custom-time retry keeps the user's explicit `to`;
 *   - declining the dialog issues no second request.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const RESHOVE = fs.readFileSync(path.join(__dirname, '..', 'public', 'reshoveMove.js'), 'utf8');

const tick = () => new Promise(r => setTimeout(r, 0));

function boot(postResponses) {
  document.open();
  document.write(HTML);
  document.close();

  window.alert = () => {};
  window.__CALLS__ = [];
  let idx = 0;
  window.fetch = (url, opts) => {
    const method = opts?.method;
    const call = { url, method, body: opts?.body ? JSON.parse(opts.body) : null };
    window.__CALLS__.push(call);
    let data = [];
    if (method === 'POST') data = postResponses[idx++] ?? {};
    return Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => data });
  };
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };

  window.eval(RESHOVE + ';' + APP + `
    ;window.__T__ = {
      pushBackJob, pullForwardJob, closeReshoveModal,
      neutralize(){ init = function(){}; renderCalendar = async function(){}; },
    };`);
  window.__T__.neutralize();
  return window.__T__;
}

const moveCalls = (endpoint) =>
  window.__CALLS__.filter(c => c.method === 'POST' && c.url.includes(`/${endpoint}`));

describe('timed-move confirm/retry flow (jsdom)', () => {
  test('to-now push-back: confirm retries with reshove:true AND the returned target', async () => {
    const target = '2026-04-13T18:30:00.000Z';
    const T = boot([{ needsReshove: true, target }, { reshoved: true, updatedCount: 3 }]);
    const p = T.pushBackJob(1, null); // to-now (no explicit `to`)
    await tick();
    T.closeReshoveModal(true); // user confirms
    await p;
    const calls = moveCalls('push-back');
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toEqual({});                       // initial to-now, no `to`
    expect(calls[1].body).toEqual({ reshove: true, to: target }); // retry pins the target
  });

  test('custom-time push-back: confirm retries keeping the explicit `to` (not target)', async () => {
    const T = boot([{ needsReshove: true, target: '2026-04-13T20:00:00.000Z' }, { reshoved: true }]);
    const p = T.pushBackJob(1, '2026-04-13T10:00:00Z');
    await tick();
    T.closeReshoveModal(true);
    await p;
    const calls = moveCalls('push-back');
    expect(calls[1].body).toEqual({ to: '2026-04-13T10:00:00Z', reshove: true });
  });

  test('decline: no second request is issued', async () => {
    const T = boot([{ needsReshove: true, target: '2026-04-13T18:30:00.000Z' }]);
    const p = T.pushBackJob(1, null);
    await tick();
    T.closeReshoveModal(false); // user cancels
    await p;
    expect(moveCalls('push-back')).toHaveLength(1);
  });

  test('pull-forward to-now: confirm retries with reshove:true + target', async () => {
    const target = '2026-04-13T12:00:00.000Z';
    const T = boot([{ needsReshove: true, target }, { reshoved: true }]);
    const p = T.pullForwardJob(1, null, null);
    await tick();
    T.closeReshoveModal(true);
    await p;
    const calls = moveCalls('pull-forward');
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ reshove: true, to: target });
  });

  test('no needsReshove: single request, dialog never shown', async () => {
    const T = boot([{ updatedCount: 1 }]);
    await T.pushBackJob(1, '2026-04-13T12:00:00Z');
    expect(moveCalls('push-back')).toHaveLength(1);
    expect(document.getElementById('reshove-modal').classList.contains('hidden')).toBe(true);
  });
});
