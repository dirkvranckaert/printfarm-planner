/**
 * @jest-environment jsdom
 *
 * Client-side 3MF import dialog, exercising the REAL public/app.js under jsdom
 * against a REAL parsed multi-plate fixture. Guards the pieces that the
 * server-side tests can't see (they trust the X-Schedule header the client
 * builds):
 *   - auto-naming: each plate's Name field defaults to its plate name;
 *   - the fuzzy-matched target printer is surfaced in the dialog header;
 *   - confirm posts queue mode with one entry per plate, carrying the per-plate
 *     objectCount as `items` and the matched printerId.
 */
const fs = require('fs');
const path = require('path');
const { parse3mf } = require('../parse3mf');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const NTC  = fs.readFileSync(path.join(__dirname, '..', 'public', 'ntc.js'), 'utf8');
const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixtures', 'two-plate.gcode.3mf');

const tick = () => new Promise(r => setTimeout(r, 0));

function boot() {
  document.open();
  document.write(HTML);
  document.close();

  window.alert = () => {};
  window.__CALLS__ = [];
  window.fetch = (url, opts) => {
    window.__CALLS__.push({ url, opts });
    // Filament catalog proxy -> empty; import endpoint -> ok.
    return Promise.resolve({ ok: true, status: 201, text: async () => '', json: async () => [] });
  };
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };

  window.eval(NTC + ';' + APP + `
    ;window.__T__ = {
      show: show3mfSchedulePreview,
      confirm: confirm3mfSchedule,
      setEnv(o){ if (o.printers) printers = o.printers; },
      setImport(o){ import3mfParsed = o.parsed; import3mfPlateOrder = o.order; import3mfBuffer = o.buffer; },
      neutralize(){ init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){}; renderCalendar = async function(){}; },
    };`);
  window.__T__.neutralize();
  return window.__T__;
}

describe('3MF import dialog (jsdom, real fixture)', () => {
  test('auto-names each plate and surfaces the fuzzy-matched target printer', () => {
    const T = boot();
    T.setEnv({ printers: [{ id: 7, name: 'Bambu Lab P1S', color: '#08c', warm_up_mins: 5, cool_down_mins: 15 }] });
    const parsed = parse3mf(FIXTURE);
    T.setImport({ parsed, order: parsed.plates.map((_, i) => i), buffer: { name: 'two-plate.gcode.3mf', buffer: new ArrayBuffer(8) } });

    T.show(parsed, 'two-plate.gcode.3mf');

    const body = document.getElementById('import3mf-body').innerHTML;
    expect(body).toContain('Target printer');
    expect(body).toContain('Bambu Lab P1S'); // fuzzy match surfaced

    // Auto-naming: Name field defaults to the plate name.
    expect(document.querySelector('[data-sched-name="0"]').value).toBe('Dino Body');
    expect(document.querySelector('[data-sched-name="1"]').value).toBe('Dino Feet');
    // Target printer preselected per plate.
    expect(document.querySelector('[data-sched-printer="0"]').value).toBe('7');
  });

  test('confirm posts queue mode, one entry per plate, carrying objectCount as items', async () => {
    const T = boot();
    T.setEnv({ printers: [{ id: 7, name: 'Bambu Lab P1S', color: '#08c', warm_up_mins: 5, cool_down_mins: 15 }] });
    const parsed = parse3mf(FIXTURE);
    T.setImport({ parsed, order: parsed.plates.map((_, i) => i), buffer: { name: 'two-plate.gcode.3mf', buffer: new ArrayBuffer(8) } });
    T.show(parsed, 'two-plate.gcode.3mf');

    await T.confirm();
    await tick();

    const importCall = window.__CALLS__.find(c => c.url === '/api/import-3mf-schedule');
    expect(importCall).toBeTruthy();
    const sent = JSON.parse(decodeURIComponent(importCall.opts.headers['X-Schedule']));
    expect(sent.mode).toBe('queue');
    expect(sent.plates).toHaveLength(2);
    expect(sent.plates.map(p => p.name)).toEqual(['Dino Body', 'Dino Feet']);
    expect(sent.plates.map(p => p.items)).toEqual([1, 2]); // objectCount forwarded
    expect(sent.plates.every(p => p.printerId === 7)).toBe(true);
  });
});
