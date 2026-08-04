/**
 * @jest-environment jsdom
 *
 * Day-view side-by-side layout for time-overlapping jobs.
 *
 * When two or more jobs overlap in time on the SAME printer they must render
 * next to each other inside that printer's column (classic calendar column
 * packing) instead of stacked on top of each other. This test covers:
 *   1. the pure interval packer computeColumnLayout() (col + nCols math), and
 *   2. the real renderDay() DOM output (inline left/width on the blocks).
 *
 * app.js is a classic browser script (no module exports), so it is evaluated
 * inside the jsdom window and the internals under test are exposed via a small
 * appended hook (same technique as day-view-click.test.js).
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const PRINTER = { id: 5, name: 'Bambulab H2C', color: '#0088cc', favourite: 1, warm_up_mins: 5, cool_down_mins: 15, brand: 'bambulab' };

function boot(jobs) {
  document.open();
  document.write(HTML);
  document.close();

  window.fetch = (url) => {
    let data = null;
    if (url === '/api/jobs') data = jobs;
    else if (url === '/api/closures') data = [];
    else {
      const m = /\/api\/jobs\/(\d+)$/.exec(url);
      if (m) data = jobs.find(j => j.id === Number(m[1])) || null;
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => data });
  };
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };

  window.eval(APP + `
    ;window.__T__ = {
      renderDay,
      computeColumnLayout,
      setEnv(o){ if(o.printers) printers = o.printers; if(o.navDate) navDate = o.navDate; if(o.closures) closures = o.closures; },
      neutralize(){
        init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){};
        renderMobilePrinterSwitcher = function(){}; applyMobilePrinterFilter = function(){};
        attachMobileDayViewSwipe = function(){}; scrollToNow = function(){}; attachDayEvents = function(){};
      },
    };`);

  const T = window.__T__;
  T.neutralize();
  T.setEnv({ printers: [PRINTER], navDate: new Date('2026-07-29T12:00:00'), closures: [] });
  return T;
}

// Minutes → ms epoch on the render test day, for readable job fixtures.
const at = (h, m = 0) => new Date(`2026-07-29T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`).getTime();
const iso = (h, m = 0) => new Date(at(h, m)).toISOString();
const job = (id, sh, eh) => ({
  id, printerId: 5, name: `Job ${id}`, customerName: null, orderNr: null,
  start: iso(sh), end: iso(eh), status: 'Planned', queued: 0, linked_printer_id: null, colors: null,
});

describe('computeColumnLayout — pure interval column packing', () => {
  const T = boot([]);
  const layout = intervals => T.computeColumnLayout(intervals);

  test('two overlapping jobs → two columns, indices 0 and 1', () => {
    const m = layout([{ id: 'a', start: 0, end: 120 }, { id: 'b', start: 60, end: 180 }]);
    expect(m.get('a')).toEqual({ col: 0, nCols: 2 });
    expect(m.get('b')).toEqual({ col: 1, nCols: 2 });
    // derived width/offset: each ~50%, offsets 0% and 50%
    for (const id of ['a', 'b']) {
      const { col, nCols } = m.get(id);
      expect(100 / nCols).toBeCloseTo(50);
      expect(col * 100 / nCols).toBeCloseTo(id === 'a' ? 0 : 50);
    }
  });

  test('three-way overlap → three columns, thirds', () => {
    const m = layout([
      { id: 'a', start: 0,  end: 240 },
      { id: 'b', start: 60, end: 300 },
      { id: 'c', start: 120, end: 180 },
    ]);
    expect(m.get('a')).toEqual({ col: 0, nCols: 3 });
    expect(m.get('b')).toEqual({ col: 1, nCols: 3 });
    expect(m.get('c')).toEqual({ col: 2, nCols: 3 });
    expect(100 / 3).toBeCloseTo(33.3333);
    expect([0, 1, 2].map(c => c * 100 / 3)).toEqual([0, 100 / 3, 200 / 3]);
  });

  test('non-overlapping jobs → each full width (nCols 1)', () => {
    const m = layout([{ id: 'a', start: 0, end: 60 }, { id: 'b', start: 120, end: 180 }]);
    expect(m.get('a')).toEqual({ col: 0, nCols: 1 });
    expect(m.get('b')).toEqual({ col: 0, nCols: 1 });
  });

  test('adjacent (touching) jobs do not overlap → full width each', () => {
    const m = layout([{ id: 'a', start: 0, end: 60 }, { id: 'b', start: 60, end: 120 }]);
    expect(m.get('a')).toEqual({ col: 0, nCols: 1 });
    expect(m.get('b')).toEqual({ col: 0, nCols: 1 });
  });

  test('partial chain A–B overlap, B–C overlap, A–C do NOT → 2 cols, A & C reuse col 0', () => {
    // A=[0,60] B=[30,90] C=[70,120]: A-B overlap, B-C overlap, A-C disjoint.
    // All transitively connected → one cluster of width 2; A and C share col 0.
    const m = layout([
      { id: 'A', start: 0,  end: 60 },
      { id: 'B', start: 30, end: 90 },
      { id: 'C', start: 70, end: 120 },
    ]);
    expect(m.get('A')).toEqual({ col: 0, nCols: 2 });
    expect(m.get('B')).toEqual({ col: 1, nCols: 2 });
    expect(m.get('C')).toEqual({ col: 0, nCols: 2 });
  });

  test('input order does not matter (sorted internally)', () => {
    const m = layout([{ id: 'b', start: 60, end: 180 }, { id: 'a', start: 0, end: 120 }]);
    expect(m.get('a')).toEqual({ col: 0, nCols: 2 });
    expect(m.get('b')).toEqual({ col: 1, nCols: 2 });
  });
});

describe('renderDay — overlapping blocks render side-by-side (real DOM)', () => {
  const pct = v => parseFloat(v); // '33.3333%' → 33.3333

  test('three overlapping jobs → three thirds, distinct left offsets, no horizontal overlap', async () => {
    const T = boot([job(1, 10, 14), job(2, 11, 15), job(3, 12, 13)]);
    await T.renderDay();
    const blocks = [...document.querySelectorAll('.job-block')].sort(
      (a, b) => Number(a.dataset.jobId) - Number(b.dataset.jobId));
    expect(blocks.map(b => Number(b.dataset.jobId))).toEqual([1, 2, 3]);

    // every block ~one third wide
    for (const b of blocks) expect(pct(b.style.width)).toBeCloseTo(100 / 3);

    // lefts are 0, 1/3, 2/3 in some assignment — all distinct, sorted set matches
    const lefts = blocks.map(b => pct(b.style.left)).sort((x, y) => x - y);
    expect(lefts[0]).toBeCloseTo(0);
    expect(lefts[1]).toBeCloseTo(100 / 3);
    expect(lefts[2]).toBeCloseTo(200 / 3);

    // no two blocks occupy the same horizontal band [left, left+width)
    for (let i = 0; i < blocks.length; i++) {
      for (let k = i + 1; k < blocks.length; k++) {
        const li = pct(blocks[i].style.left), wi = pct(blocks[i].style.width);
        const lk = pct(blocks[k].style.left), wk = pct(blocks[k].style.width);
        expect(li < lk + wk && li + wi > lk).toBe(false);
      }
    }
  });

  test('a lone (non-overlapping) job keeps full column width — no inline left/width', async () => {
    const T = boot([job(1, 9, 11)]);
    await T.renderDay();
    const block = document.querySelector('.job-block');
    expect(block).toBeTruthy();
    expect(block.style.left).toBe('');
    expect(block.style.width).toBe('');
  });

  test("a job's own buffer blocks share its sub-column when split", async () => {
    const T = boot([job(1, 10, 14), job(2, 11, 15)]);
    await T.renderDay();
    // job 1 sits in one sub-column (~50%); its cool-down buffer must match.
    const b1  = document.querySelector('.job-block[data-job-id="1"]');
    const cd1 = document.querySelector('.buffer-block[data-job-id="1"][data-buffer-type="cooldown"]');
    expect(cd1).toBeTruthy();
    expect(pct(cd1.style.width)).toBeCloseTo(50);
    expect(pct(cd1.style.left)).toBeCloseTo(pct(b1.style.left));
  });
});
