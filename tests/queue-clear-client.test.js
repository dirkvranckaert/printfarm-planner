/**
 * @jest-environment jsdom
 *
 * "Clear queue" button (#4067): sits BELOW "+ Add to Queue" in the left column of the
 * queue bar; confirm cancel = no request; confirm OK = DELETE /api/queue + skipped message.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const JOBS = [
  { id: 1, name: 'a', queued: 1, printerId: null, status: 'Planned', durationMins: 10, start: '', end: '' },
  { id: 2, name: 'b', queued: 1, printerId: null, status: 'Processing', durationMins: 0, start: '', end: '' },
];

function boot(jobs, clearResult) {
  document.open(); document.write(HTML); document.close();
  const calls = [];
  window.fetch = (url, opts = {}) => {
    if (opts.method === 'DELETE') {
      calls.push(url);
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(clearResult), json: async () => clearResult });
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => (String(url).includes('/api/jobs') ? jobs : null) });
  };
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };
  window.eval(APP + `
    ;window.__T__ = {
      renderQueuePanel,
      setEnv(o){ if(o.view) view = o.view; if(o.showQueuePanel!==undefined) showQueuePanel = o.showQueuePanel; },
      neutralize(){
        init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){};
        renderMobilePrinterSwitcher = function(){}; applyMobilePrinterFilter = function(){};
        attachMobileDayViewSwipe = function(){}; scrollToNow = function(){};
        renderCalendar = async function(){};
      },
    };`);
  const T = window.__T__;
  T.neutralize();
  T.setEnv({ view: 'day', showQueuePanel: true });
  return { T, calls };
}
const flush = () => new Promise(r => setTimeout(r, 0));

describe('Clear queue button', () => {
  test('placed below Add to Queue in the left column, not beside it', async () => {
    const { T } = boot(JOBS, {});
    await T.renderQueuePanel();
    const left = document.querySelector('.queue-panel-left');
    const kids = [...left.children].map(e => e.id || e.className);
    expect(kids.indexOf('queue-clear-btn')).toBe(kids.indexOf('queue-add-btn') + 1);
    expect(document.getElementById('queue-clear-btn').parentElement).toBe(left);
    expect(document.getElementById('queue-clear-btn').textContent).toBe('Clear queue');
  });

  test('hidden when queue is empty', async () => {
    const { T } = boot([], {});
    await T.renderQueuePanel();
    expect(document.getElementById('queue-clear-btn')).toBeNull();
    expect(document.getElementById('queue-add-btn')).not.toBeNull();
  });

  test('confirm cancel: no request', async () => {
    const { T, calls } = boot(JOBS, {});
    const confirmFn = jest.fn(() => false);
    window.confirm = confirmFn; window.alert = jest.fn();
    await T.renderQueuePanel();
    document.getElementById('queue-clear-btn').click();
    await flush(); await flush();
    expect(confirmFn).toHaveBeenCalledWith('Delete 2 queued jobs?');
    expect(calls).toEqual([]);
    expect(window.alert).not.toHaveBeenCalled();
  });

  test('confirm OK: DELETE /api/queue, message names skipped jobs', async () => {
    const { T, calls } = boot(JOBS, { deleted: 1, skipped: 1 });
    window.confirm = () => true;
    const alert = jest.fn(); window.alert = alert;
    await T.renderQueuePanel();
    document.getElementById('queue-clear-btn').click();
    await flush(); await flush();
    expect(calls).toEqual(['/api/queue']);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toMatch(/Skipped 1 still processing/);
  });

  test('confirm OK, nothing skipped: no alert', async () => {
    const { T, calls } = boot(JOBS, { deleted: 2, skipped: 0 });
    window.confirm = () => true;
    const alert = jest.fn(); window.alert = alert;
    await T.renderQueuePanel();
    document.getElementById('queue-clear-btn').click();
    await flush(); await flush();
    expect(calls).toEqual(['/api/queue']);
    expect(alert).not.toHaveBeenCalled();
  });
});
