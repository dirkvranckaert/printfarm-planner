/**
 * @jest-environment jsdom
 *
 * Queue card of a Processing split placeholder (#4051): the server answers its delete
 * with 409 {"error":...}. The UI must tell the user (alert with the server message)
 * instead of failing silently; a successful delete shows no alert.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const MSG = 'A plate split is still running for this job; try again when it finishes';
const PLACEHOLDER = { id: 7, name: 'keychain', queued: 1, printerId: null, status: 'Processing', durationMins: 0, start: '', end: '' };

function boot(deleteResponse) {
  document.open(); document.write(HTML); document.close();
  const deletes = [];
  window.fetch = (url, opts = {}) => {
    if (opts.method === 'DELETE') {
      deletes.push(url);
      return Promise.resolve(deleteResponse);
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => (String(url).includes('/api/jobs') ? [PLACEHOLDER] : null) });
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
  return { T, deletes };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('delete on a Processing queue card', () => {
  test('409 shows the server message in an alert', async () => {
    const { T, deletes } = boot({ ok: false, status: 409, text: async () => JSON.stringify({ error: MSG }) });
    window.confirm = () => true;
    const alert = jest.fn();
    window.alert = alert;
    await T.renderQueuePanel();
    document.querySelector('.queue-delete-btn').click();
    await flush(); await flush();
    expect(deletes).toEqual(['/api/jobs/7']);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toContain(MSG);
    expect(alert.mock.calls[0][0]).not.toContain('{"error"');
  });

  test('success: no alert', async () => {
    const { T } = boot({ ok: true, status: 204, text: async () => '' });
    window.confirm = () => true;
    const alert = jest.fn();
    window.alert = alert;
    await T.renderQueuePanel();
    document.querySelector('.queue-delete-btn').click();
    await flush(); await flush();
    expect(alert).not.toHaveBeenCalled();
  });
});
