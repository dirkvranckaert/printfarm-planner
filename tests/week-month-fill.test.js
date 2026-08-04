// Week + Month views must fill the full calendar area (width AND height).
//
// There was never an explicit max-width / centering cap on these views — they
// already stretch to full width via the 1fr grid columns / table width:100%.
// The unused real estate was VERTICAL: the month grid's week rows were
// content-sized (~90px) and clumped at the top, and the week table didn't fill
// height. This guards the fill rules against regressing and asserts no width cap
// creeps in. Pure CSS contract — jsdom can't compute layout, so we assert the
// stylesheet declarations directly.

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

// Extract the declaration body of a top-level `selector { ... }` rule (CSS here
// is flat — no nested blocks — so a non-greedy match to the next `}` is safe).
function ruleBlock(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(esc + '\\s*\\{([^}]*)\\}').exec(CSS);
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[1].replace(/\s+/g, ' ');
}

describe('month view fills the calendar area', () => {
  const view = ruleBlock('.month-view');
  const grid = ruleBlock('.month-grid');

  test('.month-view is a column flex that grows (flex:1), no width cap', () => {
    expect(view).toMatch(/flex:\s*1/);
    expect(view).toMatch(/flex-direction:\s*column/);
    expect(view).not.toMatch(/max-width/);
  });

  test('.month-grid fills width (7 × 1fr columns, width:100%) and height (flex:1 + 1fr rows)', () => {
    expect(grid).toMatch(/grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
    expect(grid).toMatch(/width:\s*100%/);
    expect(grid).toMatch(/flex:\s*1/);
    expect(grid).toMatch(/grid-auto-rows:\s*1fr/);
    expect(grid).not.toMatch(/max-width/);
  });
});

describe('week view fills the calendar area', () => {
  const view = ruleBlock('.week-view');
  const table = ruleBlock('.week-table');

  test('.week-view grows (flex:1), no width cap', () => {
    expect(view).toMatch(/flex:\s*1/);
    expect(view).not.toMatch(/max-width/);
  });

  test('.week-table fills full width and height (rows grow, not clumped)', () => {
    expect(table).toMatch(/width:\s*100%/);
    expect(table).toMatch(/height:\s*100%/);
    expect(table).not.toMatch(/max-width/);
  });

  test('printer rows are divided equally (each tbody tr = 1/N of the height)', () => {
    expect(ruleBlock('.week-table tbody tr')).toMatch(/height:\s*calc\(100%\s*\/\s*var\(--week-rows/);
  });

  test('renderWeek passes the printer count to CSS via --week-rows', () => {
    const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    expect(APP).toMatch(/--week-rows:\$\{printers\.length\}/);
  });
});
