/**
 * @jest-environment jsdom
 *
 * AMS remaining-level: pure math (public/amsLevel.js) + slot tile markup
 * (slotCardHtml in public/app.js) + server ingest of tray_weight (bambu.js).
 */
const fs = require('fs');
const path = require('path');
const amsLevel = require('../public/amsLevel.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

describe('fillPct', () => {
  test('unknown (null / undefined / -1 / NaN) renders full', () => {
    for (const v of [null, undefined, -1, NaN, 'x']) expect(amsLevel.fillPct(v)).toBe(100);
  });
  test('proportional in the normal range', () => {
    expect(amsLevel.fillPct(42)).toBe(42);
    expect(amsLevel.fillPct(100)).toBe(100);
  });
  test('near empty keeps the minimum band', () => {
    expect(amsLevel.fillPct(0)).toBe(amsLevel.MIN_BAND);
    expect(amsLevel.fillPct(5)).toBe(amsLevel.MIN_BAND);
    expect(amsLevel.fillPct(amsLevel.MIN_BAND + 1)).toBe(amsLevel.MIN_BAND + 1);
  });
  test('over 100 is clamped', () => {
    expect(amsLevel.fillPct(250)).toBe(100);
  });
});

describe('grams / tooltip', () => {
  test('grams = round(pct/100 * weight)', () => {
    expect(amsLevel.grams(42, 1000)).toBe(420);
    expect(amsLevel.grams(33, 250)).toBe(83); // 82.5 -> 83
    expect(amsLevel.grams(0, 1000)).toBe(0);
  });
  test('grams null when percent or weight unknown', () => {
    expect(amsLevel.grams(-1, 1000)).toBeNull();
    expect(amsLevel.grams(42, null)).toBeNull();
    expect(amsLevel.grams(42, 0)).toBeNull();
  });
  test('tooltip variants', () => {
    expect(amsLevel.tooltip('PLA', 42, 1000)).toBe('PLA · 42% · ~420 g');
    expect(amsLevel.tooltip('PLA', 42, null)).toBe('PLA · 42%');
    expect(amsLevel.tooltip('PLA', -1, 1000)).toBe('PLA · remaining unknown');
    expect(amsLevel.tooltip('PLA', null, null)).toBe('PLA · remaining unknown');
  });
});

describe('slotCardHtml', () => {
  function boot() {
    document.open(); document.write(HTML); document.close();
    window.fetch = () => Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => null });
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    window.requestAnimationFrame = cb => setTimeout(cb, 0);
    window.EventSource = class { close() {} addEventListener() {} };
    window.amsLevel = amsLevel;
    window.eval(APP + `
      ;window.__T__ = { slotCardHtml,
        neutralize(){ init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){}; } };`);
    return window.__T__;
  }
  const T = boot(); T.neutralize();
  const base = { id: 'A1', label: 'PLA', color: '#FF0000', material: 'PLA', k: null, active: false, empty: false };

  test('known level: fill height + tooltip with grams', () => {
    const h = T.slotCardHtml({ ...base, remainPct: 42, trayWeight: 1000 });
    expect(h).toContain('ams-slot-fill');
    expect(h).toContain('height:42%');
    expect(h).toContain('title="PLA · 42% · ~420 g"');
  });
  test('near empty uses the minimum band', () => {
    const h = T.slotCardHtml({ ...base, remainPct: 3, trayWeight: 1000 });
    expect(h).toContain(`height:${amsLevel.MIN_BAND}%`);
  });
  test('unknown level: full look, no fill element, tooltip says unknown', () => {
    const h = T.slotCardHtml({ ...base, remainPct: -1, trayWeight: 1000 });
    expect(h).not.toContain('ams-slot-fill');
    expect(h).toContain('background:#FF0000');
    expect(h).toContain('remaining unknown');
  });
  test('empty slot unchanged: no fill, no tooltip', () => {
    const h = T.slotCardHtml({ id: 'A2', label: 'Empty', color: null, material: null, empty: true, remainPct: 0, trayWeight: 0 });
    expect(h).not.toContain('ams-slot-fill');
    expect(h).not.toContain('title=');
  });
});

describe('fill CSS (review round 1)', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const rule = sel => (CSS.match(new RegExp(sel.replace('.', '\\.') + '\\s*\\{([^}]*)\\}')) || [])[1] || '';
  test('tile does not clip overflow (long labels stay unclipped)', () => {
    expect(rule('.ams-slot-leveled')).not.toMatch(/overflow/);
  });
  test('fill has its own boundary so level shows when spool colour equals tile colour', () => {
    expect(rule('.ams-slot-fill')).toMatch(/border-top:\s*1px solid/);
  });
});

describe('bambu.js ingest', () => {
  test('parseMessage forwards remain and tray_weight per tray', () => {
    const bambu = require('../bambu.js');
    let got;
    bambu.onUpdate((s, st) => { got = st; });
    const payload = JSON.stringify({ print: { gcode_state: 'IDLE', ams: { tray_now: '0', ams: [{ id: '0', tray: [
      { id: '0', tray_type: 'PLA', tray_color: 'FF0000FF', remain: 91, tray_weight: '1000' },
      { id: '1', tray_type: 'PETG', tray_color: '00FF00FF', remain: -1 },
    ] }] } } });
    bambu._parseMessage('SERIAL1', Buffer.from(payload));
    expect(got.slots[0]).toMatchObject({ remainPct: 91, trayWeight: 1000 });
    expect(got.slots[1]).toMatchObject({ remainPct: -1, trayWeight: null });
  });
});
