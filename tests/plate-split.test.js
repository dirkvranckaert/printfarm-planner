// Unit tests for the per-plate 3MF split (#4051): zip-lite + plate-split + upload-stream.
// Synthetic sliced 3MFs only (tests/helpers/sliced-3mf.js); never touches data/uploads.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const zip = require('../zip-lite');
const plateSplit = require('../plate-split');
const { streamToFile } = require('../upload-stream');
const { buildSliced3mf } = require('./helpers/sliced-3mf');

describe('plate split (zip-lite + plate-split)', () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-split-unit-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const read = async (file, name) => (await zip.readNamed(file, name))?.toString('utf8');

  test('listSlicedPlates: sorted plate indexes of a multi-plate file', async () => {
    const src = path.join(dir, 'list.gcode.3mf');
    await buildSliced3mf(src, 3);
    expect(await plateSplit.listSlicedPlates(src)).toEqual([1, 2, 3]);
  });

  test('single-plate source: only one sliced plate (no split needed); unsliced fixture lists none', async () => {
    const one = path.join(dir, 'one.gcode.3mf');
    await buildSliced3mf(one, 1);
    expect(await plateSplit.listSlicedPlates(one)).toEqual([1]);
    const fixture = path.join(__dirname, 'fixtures', 'two-plate.gcode.3mf');
    expect(await plateSplit.listSlicedPlates(fixture)).toEqual([]);
  });

  test('splitPlate(2 of 3): plate 2 becomes plate 1, everything else consistent, valid zip', async () => {
    const src = path.join(dir, 'src3.gcode.3mf');
    const out = path.join(dir, 'out2.gcode.3mf');
    await buildSliced3mf(src, 3);
    await plateSplit.splitPlate(src, 2, out);

    // gcode (+ md5) is plate 2's, byte for byte, under the plate_1 name
    expect(await read(out, 'Metadata/plate_1.gcode')).toBe(await read(src, 'Metadata/plate_2.gcode'));
    expect(await read(out, 'Metadata/plate_1.gcode.md5')).toBe('md5-of-plate-2');
    const z = await zip.openZip(out);
    const names = z.entries.map(e => e.name);
    await z.close();
    expect(names.filter(n => /plate_\d+\.gcode$/.test(n))).toEqual(['Metadata/plate_1.gcode']);
    expect(names.some(n => /(plate|top|pick)_[23]/.test(n))).toBe(false);
    expect(names[0]).toBe('[Content_Types].xml');

    const slice = await read(out, 'Metadata/slice_info.config');
    expect((slice.match(/<plate>/g) || []).length).toBe(1);
    expect(slice).toContain('key="index" value="1"');
    expect(slice).toContain('key="prediction" value="1200"'); // plate 2: 2 * 600
    const ms = await read(out, 'Metadata/model_settings.config');
    expect((ms.match(/<plate>/g) || []).length).toBe(1);
    expect(ms).toContain('key="plater_id" value="1"');
    expect(ms).toContain('Plate name 2');
    expect(ms).toContain('Metadata/plate_1.png');
    expect(ms).not.toMatch(/plate_2|top_2|pick_2/);
    const rels = await read(out, 'Metadata/_rels/model_settings.config.rels');
    expect(rels).toContain('/plate_1.gcode');
    expect(rels).toContain('Id="rel-1"');
    expect(rels).not.toMatch(/plate_[23]\.gcode/);
    expect(JSON.parse(await read(out, 'Metadata/filament_sequence.json'))).toEqual({ plate_1: { sequence: [2] } });

    // custom_gcode_per_layer.xml (H2C/H3C): only plate 2's block, renumbered to id 1
    const cg = await read(out, 'Metadata/custom_gcode_per_layer.xml');
    expect((cg.match(/<plate>/g) || []).length).toBe(1);
    expect(cg).toContain('<plate_info id="1"');
    expect(cg).toContain('top_z="2.2"');
    expect(cg).not.toContain('top_z="1.2"');
    expect(cg).not.toContain('top_z="3.2"');

    expect(fs.existsSync(`${out}.part`)).toBe(false);
    // independent check that the written archive is a valid zip (CRCs included)
    expect(() => execFileSync('unzip', ['-tq', out], { stdio: 'pipe' })).not.toThrow();
  });

  test('printer without custom_gcode_per_layer.xml (P1S) splits too', async () => {
    const src = path.join(dir, 'p1s.gcode.3mf');
    const out = path.join(dir, 'p1s-out.gcode.3mf');
    await buildSliced3mf(src, 2, { h2c: false });
    await plateSplit.splitPlate(src, 1, out);
    expect(await plateSplit.listSlicedPlates(out)).toEqual([1]);
    expect(await plateSplit.readPrinterName(out)).toBe('Bambu Lab P1S');
  });

  test('missing plate: throws, leaves no dest and no .part', async () => {
    const src = path.join(dir, 'missing.gcode.3mf');
    const out = path.join(dir, 'missing-out.gcode.3mf');
    await buildSliced3mf(src, 2);
    await expect(plateSplit.splitPlate(src, 5, out)).rejects.toThrow(/no sliced gcode/);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(`${out}.part`)).toBe(false);
  });

  test('corrupt input (not a zip / truncated): rejects, no leftovers', async () => {
    const out = path.join(dir, 'corrupt-out.gcode.3mf');
    const junk = path.join(dir, 'junk.3mf');
    fs.writeFileSync(junk, Buffer.alloc(500, 7));
    await expect(plateSplit.splitPlate(junk, 1, out)).rejects.toThrow(/zip/i);
    expect(await plateSplit.listSlicedPlates(junk).catch(() => 'threw')).toBe('threw');

    const good = path.join(dir, 'good.gcode.3mf');
    await buildSliced3mf(good, 2);
    const trunc = path.join(dir, 'trunc.3mf');
    fs.writeFileSync(trunc, fs.readFileSync(good).subarray(0, 300));
    await expect(plateSplit.splitPlate(trunc, 1, out)).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(`${out}.part`)).toBe(false);
  });

  test('ZIP64 archive is refused with a clear error (caller shows "Split failed")', async () => {
    const good = path.join(dir, 'z64src.gcode.3mf');
    await buildSliced3mf(good, 2);
    const buf = Buffer.from(fs.readFileSync(good));
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    buf.writeUInt16LE(0xffff, eocd + 10); // total entries = ZIP64 marker
    const z64 = path.join(dir, 'z64.3mf');
    fs.writeFileSync(z64, buf);
    await expect(plateSplit.splitPlate(z64, 1, path.join(dir, 'z64-out.3mf'))).rejects.toThrow(/ZIP64/);
  });

  // F1: the central-directory usize is attacker-declared; inflate must not trust it.
  const lyingZip = async (file, declaredUsize, content) => {
    const w = new zip.ZipWriter(file);
    const comp = require('zlib').deflateRawSync(content);
    await w._write(w._local('a.bin', { method: 8, time: 0, date: 0x21, crc: zip.crc32(content), csize: comp.length, usize: declaredUsize }));
    await w._write(comp);
    await w.finish();
  };

  test('readEntry: entry inflating past its declared size is rejected (decompression bomb)', async () => {
    const f = path.join(dir, 'bomb.zip');
    await lyingZip(f, 10, Buffer.alloc(1024 * 1024, 0));
    await expect(zip.readNamed(f, 'a.bin')).rejects.toThrow();
  });

  test('readEntry: entry inflating short of its declared size is rejected', async () => {
    const f = path.join(dir, 'short.zip');
    await lyingZip(f, 5000, Buffer.alloc(100, 1));
    await expect(zip.readNamed(f, 'a.bin')).rejects.toThrow(/Size mismatch/);
  });

  // Round-2 F1: csize/usize/method/cd bounds are checked before any allocation.
  const patchedZip = async (file, { method = 8, content = Buffer.alloc(64, 1), csize, usize, cdSize, cdOffset } = {}) => {
    const w = new zip.ZipWriter(file);
    const comp = method === 0 ? content : require('zlib').deflateRawSync(content);
    await w._write(w._local('a.bin', { method, time: 0, date: 0x21, crc: zip.crc32(content), csize: comp.length, usize: content.length }));
    await w._write(comp);
    await w.finish();
    const buf = Buffer.from(fs.readFileSync(file));
    const cen = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (csize !== undefined) buf.writeUInt32LE(csize, cen + 20);
    if (usize !== undefined) buf.writeUInt32LE(usize, cen + 24);
    if (method === 0) buf.writeUInt16LE(0, cen + 10);
    if (cdSize !== undefined) buf.writeUInt32LE(cdSize, eocd + 12);
    if (cdOffset !== undefined) buf.writeUInt32LE(cdOffset, eocd + 16);
    fs.writeFileSync(file, buf);
  };
  const allocSpy = () => jest.spyOn(Buffer, 'alloc');
  const maxAlloc = spy => Math.max(0, ...spy.mock.calls.map(c => Number(c[0]) || 0));

  test('readEntry: huge declared csize (deflate) is rejected without allocating it', async () => {
    const f = path.join(dir, 'bigc-deflate.zip');
    await patchedZip(f, { csize: 0xfffffff0, usize: 0 });
    const spy = allocSpy();
    try {
      await expect(zip.readNamed(f, 'a.bin')).rejects.toThrow(/too large/);
      expect(maxAlloc(spy)).toBeLessThan(1024 * 1024);
    } finally { spy.mockRestore(); }
  });

  test('readEntry: huge declared csize (stored) is rejected without allocating it', async () => {
    const f = path.join(dir, 'bigc-stored.zip');
    await patchedZip(f, { method: 0, csize: 0xfffffff0, usize: 0xfffffff0 });
    const spy = allocSpy();
    try {
      await expect(zip.readNamed(f, 'a.bin')).rejects.toThrow(/too large/);
      expect(maxAlloc(spy)).toBeLessThan(1024 * 1024);
    } finally { spy.mockRestore(); }
  });

  test('readEntry: csize within the cap but beyond the real file is rejected before alloc', async () => {
    const f = path.join(dir, 'beyond.zip');
    await patchedZip(f, { csize: 20 * 1024 * 1024, usize: 20 * 1024 * 1024 });
    const spy = allocSpy();
    try {
      await expect(zip.readNamed(f, 'a.bin')).rejects.toThrow(/outside file/);
      expect(maxAlloc(spy)).toBeLessThan(1024 * 1024);
    } finally { spy.mockRestore(); }
  });

  test('readEntry: stored entry must have csize === usize', async () => {
    const f = path.join(dir, 'stored-mismatch.zip');
    await patchedZip(f, { method: 0, content: Buffer.alloc(64, 2), usize: 10 });
    await expect(zip.readNamed(f, 'a.bin')).rejects.toThrow(/Size mismatch/);
  });

  test('readEntry: stored entry honest size reads back', async () => {
    const f = path.join(dir, 'stored-ok.zip');
    await patchedZip(f, { method: 0, content: Buffer.alloc(64, 3) });
    expect((await zip.readNamed(f, 'a.bin')).equals(Buffer.alloc(64, 3))).toBe(true);
  });

  test('readEntry: unknown compression method is rejected before reading data', async () => {
    const f = path.join(dir, 'method99.zip');
    await patchedZip(f);
    const buf = Buffer.from(fs.readFileSync(f));
    buf.writeUInt16LE(99, buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    fs.writeFileSync(f, buf);
    await expect(zip.readNamed(f, 'a.bin')).rejects.toThrow(/Unsupported compression method 99/);
  });

  test('openZip: central directory size/offset declared past the file is rejected before alloc', async () => {
    const f = path.join(dir, 'bigcd.zip');
    await patchedZip(f, { cdSize: 0xfffffff0 });
    const spy = allocSpy();
    try {
      await expect(zip.openZip(f)).rejects.toThrow(/central directory/);
      expect(maxAlloc(spy)).toBeLessThan(1024 * 1024);
    } finally { spy.mockRestore(); }
  });

  test('readEntry: honest entry still reads back exactly', async () => {
    const f = path.join(dir, 'honest.zip');
    const data = Buffer.alloc(4096, 7);
    await lyingZip(f, data.length, data);
    expect((await zip.readNamed(f, 'a.bin')).equals(data)).toBe(true);
  });

  test('readThumbnails returns per-plate pngs', async () => {
    const src = path.join(dir, 'thumbs.gcode.3mf');
    await buildSliced3mf(src, 3);
    const t = await plateSplit.readThumbnails(src);
    expect(t.map(x => x.plateIndex)).toEqual([1, 2, 3]);
  });
});

describe('streamToFile (upload streaming)', () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-stream-unit-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('writes the body to disk and reports its size', async () => {
    const dest = path.join(dir, 'ok.bin');
    const r = await streamToFile(Readable.from([Buffer.alloc(1000, 1), Buffer.alloc(500, 2)]), dest, 5000);
    expect(r.size).toBe(1500);
    expect(fs.statSync(dest).size).toBe(1500);
  });

  test('over the limit: 413 and the partial file is removed', async () => {
    const dest = path.join(dir, 'big.bin');
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(1000, 3));
    await expect(streamToFile(Readable.from(chunks), dest, 4500)).rejects.toMatchObject({ status: 413 });
    expect(fs.existsSync(dest)).toBe(false);
  });

  test('empty body: 400 and no file', async () => {
    const dest = path.join(dir, 'empty.bin');
    await expect(streamToFile(Readable.from([]), dest, 1000)).rejects.toMatchObject({ status: 400 });
    expect(fs.existsSync(dest)).toBe(false);
  });
});
