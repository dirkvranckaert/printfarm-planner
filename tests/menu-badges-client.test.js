/**
 * @jest-environment jsdom
 *
 * #4051 client: shared .menu-badge for Queue / Projecten / the ⋮ menu (sum of its
 * entries, hidden at 0), UI prefs persisted in localStorage, split download name.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function boot() {
  document.open(); document.write(HTML); document.close();
  window.fetch = () => Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => null });
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };
  window.eval(APP + `
    ;window.__T__ = {
      setMenuBadge, updateTopbarMenuBadge, splitDownloadName, uiPrefGet, uiPrefSet,
      neutralize(){ init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){}; },
    };`);
  return window.__T__;
}
const T = boot(); T.neutralize();
const badge = id => document.getElementById(id);

test('badges use the one shared .menu-badge class and start hidden', () => {
  for (const id of ['queue-badge', 'projects-badge', 'topbar-menu-badge', 'status-overview-badge']) {
    expect(badge(id).classList.contains('menu-badge')).toBe(true);
    expect(badge(id).classList.contains('hidden')).toBe(true);
  }
});

test('setMenuBadge shows the count, hides at 0', () => {
  T.setMenuBadge('queue-badge', 4);
  expect(badge('queue-badge').textContent).toBe('4');
  expect(badge('queue-badge').classList.contains('hidden')).toBe(false);
  T.setMenuBadge('queue-badge', 0);
  expect(badge('queue-badge').classList.contains('hidden')).toBe(true);
});

test('⋮ badge = sum of the entry badges inside the menu; hidden at 0', () => {
  T.setMenuBadge('status-overview-badge', 3);
  T.updateTopbarMenuBadge();
  expect(badge('topbar-menu-badge').textContent).toBe('3');
  expect(badge('topbar-menu-badge').classList.contains('hidden')).toBe(false);
  T.setMenuBadge('status-overview-badge', 0);
  T.updateTopbarMenuBadge();
  expect(badge('topbar-menu-badge').classList.contains('hidden')).toBe(true);
});

test('queue panel / printer panel state persists via localStorage', () => {
  expect(T.uiPrefGet('showQueuePanel')).toBe(false);
  T.uiPrefSet('showQueuePanel', true);
  expect(localStorage.getItem('pf.showQueuePanel')).toBe('1');
  expect(T.uiPrefGet('showQueuePanel')).toBe(true);
  T.uiPrefSet('statusPanelOpen', false);
  expect(T.uiPrefGet('statusPanelOpen')).toBe(false);
});

test('splitDownloadName: <orig>_plate<N>.gcode.3mf only for split jobs', () => {
  expect(T.splitDownloadName({ original_file: 'a.3mf', printFile: 'b.3mf', plate_index: 2, source_name: 'my file', name: 'x' })).toBe('my_file_plate2.gcode.3mf');
  expect(T.splitDownloadName({ original_file: null, printFile: 'b.3mf', plate_index: 2, name: 'x' })).toBeNull();
  expect(T.splitDownloadName({ original_file: 'b.3mf', printFile: 'b.3mf', plate_index: 2, name: 'x' })).toBeNull();
});
