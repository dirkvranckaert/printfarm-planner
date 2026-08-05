// Parse-level coverage for the 3MF import, driven by a REAL multi-plate
// `.gcode.3mf` fixture (tests/fixtures/two-plate.gcode.3mf) rather than a
// hand-built plates array. This proves the end-to-end extraction the import
// relies on: every plate enumerated, per-plate objectCount / plateName /
// bedType / filament type, the sliced flag, the fuzzy-match printer name, and
// a thumbnail carried for EACH plate.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { parse3mf, extractThumbnails } = require('../parse3mf');

const FIXTURE = path.join(__dirname, 'fixtures', 'two-plate.gcode.3mf');

describe('parse3mf — real multi-plate fixture', () => {
  test('enumerates BOTH plates with per-plate metadata', () => {
    const p = parse3mf(FIXTURE);
    expect(p.sliced).toBe(true);
    expect(p.printerName).toBe('Bambu Lab P1S');
    expect(p.plates).toHaveLength(2);

    const [p1, p2] = p.plates;
    expect(p1.index).toBe(1);
    expect(p1.plateName).toBe('Dino Body');
    expect(p1.objectCount).toBe(1);
    expect(p1.objects).toEqual(['Dino']);
    expect(p1.printTimeMinutes).toBe(120);
    expect(p1.bedType).toBe('textured_plate');
    expect(p1.filamentType).toBe('PLA');

    expect(p2.index).toBe(2);
    expect(p2.plateName).toBe('Dino Feet');
    expect(p2.objectCount).toBe(2); // two "Foot" objects
    expect(p2.printTimeMinutes).toBe(45);
  });

  test('extracts a thumbnail for EACH plate', () => {
    const thumbs = extractThumbnails(FIXTURE);
    expect(thumbs.map(t => t.plateIndex)).toEqual([1, 2]);
    for (const t of thumbs) expect(t.buffer.length).toBeGreaterThanOrEqual(100);
  });
});

describe('extractThumbnails — a plate gap must not stop the scan', () => {
  // Regression for parse3mf.js: the loop used to `break` on the first missing
  // plate_N.png, silently dropping every later plate's render. Build a 3MF with
  // a GAP (plate_1 + plate_3, no plate_2) and prove plate 3 still comes through.
  test('returns plates 1 and 3 when plate 2 has no thumbnail', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gap3mf-'));
    const meta = path.join(tmp, 'Metadata');
    fs.mkdirSync(meta, { recursive: true });
    const png = Buffer.alloc(200, 0x89); // >=100 bytes so it is kept
    fs.writeFileSync(path.join(meta, 'plate_1.png'), png);
    fs.writeFileSync(path.join(meta, 'plate_3.png'), png);
    const zipPath = path.join(tmp, 'gap.gcode.3mf');
    execSync(`cd "${tmp}" && zip -r -X -q "${zipPath}" Metadata`);

    const thumbs = extractThumbnails(zipPath);
    expect(thumbs.map(t => t.plateIndex)).toEqual([1, 3]);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
