'use strict';

/**
 * Split one plate out of a multi-plate sliced `.gcode.3mf` into a standalone
 * single-plate file (plate N is renumbered to plate 1), so the file a job points
 * at can never be printed with the wrong plate.
 *
 * Streams from disk (zip-lite): only the small config entries are inflated into
 * memory; plate gcode/images are copied as raw compressed bytes (no recompress,
 * the `.gcode.md5` stays valid). Recipe validated in the #4051 POC against
 * P1S / H2C / H3C files, including the H3C `custom_gcode_per_layer.xml` case.
 */

const fs = require('fs');
const zip = require('./zip-lite');
const { parseSliceInfo } = require('./parse3mf');

const PLATE_FILE = /^Metadata\/(plate_no_light|plate|top|pick)_(\d+)(_small)?\.(png|json|gcode|gcode\.md5)$/;
const GCODE = /^Metadata\/plate_(\d+)\.gcode$/;
const MAX_THUMB_BYTES = 2 * 1024 * 1024; // real plate thumbnails: 4-35 KB
const MAX_THUMBS_TOTAL = 16 * 1024 * 1024;

/** Sliced plate indexes present in the archive (sorted); [] when not a sliced 3MF. */
async function listSlicedPlates(filePath) {
  const z = await zip.openZip(filePath);
  try {
    return z.entries
      .map(e => GCODE.exec(e.name))
      .filter(Boolean)
      .map(m => Number(m[1]))
      .sort((a, b) => a - b);
  } finally { await z.close(); }
}

/** Embedded printer model (project_settings.config `printer_model`), or null. Async, no shelling out. */
async function readPrinterName(filePath) {
  try {
    const buf = await zip.readNamed(filePath, 'Metadata/project_settings.config');
    return buf ? (JSON.parse(buf.toString('utf8')).printer_model || null) : null;
  } catch { return null; }
}

/** `Metadata/plate_N.png` thumbnails as [{plateIndex, buffer}] (skips missing/tiny ones). */
async function readThumbnails(filePath) {
  const z = await zip.openZip(filePath);
  try {
    const out = [];
    let total = 0;
    for (const e of z.entries) {
      const m = /^Metadata\/plate_(\d+)\.png$/.exec(e.name);
      if (!m) continue;
      // Thumbnails are retained in memory until written: cap each and the sum
      // (real ones are ~100s of KB) so a crafted archive can't pile up 32 MiB x N.
      if (e.usize > MAX_THUMB_BYTES || total + e.usize > MAX_THUMBS_TOTAL) continue;
      total += e.usize;
      const buffer = await zip.readEntry(z, e);
      if (buffer.length >= 100) out.push({ plateIndex: Number(m[1]), buffer });
    }
    return out;
  } finally { await z.close(); }
}

function blocks(xml) {
  const found = [...xml.matchAll(/[ \t]*<plate>[\s\S]*?<\/plate>\n?/g)];
  if (!found.length) throw new Error('No <plate> blocks found');
  const last = found[found.length - 1];
  return [xml.slice(0, found[0].index), found.map(m => m[0]), xml.slice(last.index + last[0].length)];
}
const metaInt = (blk, key) => {
  const m = new RegExp(`key="${key}" value="(\\d+)"`).exec(blk);
  return m ? Number(m[1]) : null;
};

/** Per-entry text rewrites. Each throws if plate N is missing (caller -> "Split failed"). */
function makeEdits(N) {
  const pick = (xml, key, what) => {
    const [pre, bl, post] = blocks(xml);
    const blk = bl.find(b => metaInt(b, key) === N);
    if (!blk) throw new Error(`Plate ${N} not found in ${what}`);
    return [pre, blk, post];
  };
  return {
    'Metadata/slice_info.config': xml => {
      const [pre, blk, post] = pick(xml, 'index', 'slice_info.config');
      return pre + blk.replace(/(key="index" value=")\d+(")/, '$11$2') + post;
    },
    'Metadata/model_settings.config': xml => {
      const [pre, blk, post] = pick(xml, 'plater_id', 'model_settings.config');
      const fixed = blk
        .replace(/(key="plater_id" value=")\d+(")/, '$11$2')
        .replace(/(value="Metadata\/(?:plate_no_light|plate|top|pick)_)\d+(\.(?:png|json|gcode)")/g, '$11$2');
      return pre + fixed + post;
    },
    'Metadata/_rels/model_settings.config.rels': xml => xml.split('\n')
      .filter(l => !/plate_\d+\.gcode/.test(l) || l.includes(`/plate_${N}.gcode`))
      .map(l => l.replace(`/plate_${N}.gcode`, '/plate_1.gcode').replace(/Id="rel-\d+"/, 'Id="rel-1"'))
      .join('\n'),
    // H2C/H3C: per-plate tool_change blocks keyed by <plate_info id="N"/>.
    'Metadata/custom_gcode_per_layer.xml': xml => {
      const found = [...xml.matchAll(/[ \t]*<plate>[\s\S]*?<\/plate>\n?/g)];
      if (!found.length) return xml;
      const mine = found.find(m => new RegExp(`<plate_info id="${N}"`).test(m[0]));
      const last = found[found.length - 1];
      return xml.slice(0, found[0].index)
        + (mine ? mine[0].replace(/(<plate_info id=")\d+(")/, '$11$2') : '')
        + xml.slice(last.index + last[0].length);
    },
    'Metadata/filament_sequence.json': txt => JSON.stringify({ plate_1: JSON.parse(txt)[`plate_${N}`] }),
  };
}

/**
 * Write the single-plate file for plate `plateIndex` of `srcPath` to `destPath`
 * (via `<dest>.part`, atomic rename; cleaned up on any failure). Self-checks the
 * result against the source plate's slice_info (1 plate, same time/weight/filaments).
 */
async function splitPlate(srcPath, plateIndex, destPath) {
  const N = Number(plateIndex);
  const part = `${destPath}.part`;
  const src = await zip.openZip(srcPath);
  let writer;
  try {
    if (!src.byName.has(`Metadata/plate_${N}.gcode`)) throw new Error(`Plate ${N} has no sliced gcode`);
    const edits = makeEdits(N);
    writer = new zip.ZipWriter(part);

    const order = src.entries.filter(e => !e.name.endsWith('/'));
    const ct = order.find(e => e.name === '[Content_Types].xml');
    const ordered = ct ? [ct, ...order.filter(e => e !== ct)] : order;
    const seen = new Set();
    for (const e of ordered) {
      const m = PLATE_FILE.exec(e.name);
      let outName = e.name;
      if (m) {
        if (Number(m[2]) !== N) continue;
        outName = `Metadata/${m[1]}_1${m[3] || ''}.${m[4]}`;
      }
      if (seen.has(outName)) continue;
      seen.add(outName);
      const edit = edits[e.name];
      if (edit) {
        const text = (await zip.readEntry(src, e)).toString('utf8');
        await writer.addBuffer(outName, Buffer.from(edit(text), 'utf8'), e);
      } else {
        await writer.addRaw(src, e, outName);
      }
    }
    await writer.finish();
    writer = null;
    await verifySplit(srcPath, N, part);
    await fs.promises.rename(part, destPath);
  } catch (err) {
    if (writer) writer.abort();
    await fs.promises.rm(part, { force: true });
    throw err;
  } finally {
    await src.close();
  }
}

async function plateSummary(filePath, plateIndex) {
  const buf = await zip.readNamed(filePath, 'Metadata/slice_info.config');
  if (!buf) throw new Error('slice_info.config missing');
  const plates = parseSliceInfo(buf.toString('utf8'));
  const p = plates.find(pl => pl.index === plateIndex);
  if (!p) throw new Error(`Plate ${plateIndex} missing in slice_info.config`);
  return { count: plates.length, p };
}

async function verifySplit(srcPath, N, outPath) {
  const z = await zip.openZip(outPath);
  try {
    const gcodes = z.entries.filter(e => GCODE.test(e.name)).map(e => e.name);
    if (gcodes.length !== 1 || gcodes[0] !== 'Metadata/plate_1.gcode') throw new Error('Split self-check failed: gcode entries');
    if (z.entries.some(e => { const m = PLATE_FILE.exec(e.name); return m && Number(m[2]) !== 1; })) {
      throw new Error('Split self-check failed: stray plate entries');
    }
  } finally { await z.close(); }
  const a = await plateSummary(srcPath, N);
  const b = await plateSummary(outPath, 1);
  const same = b.count === 1
    && a.p.printTimeSeconds === b.p.printTimeSeconds
    && a.p.weightGrams === b.p.weightGrams
    && JSON.stringify(a.p.filaments) === JSON.stringify(b.p.filaments);
  if (!same) throw new Error('Split self-check failed: plate data differs from source');
}

module.exports = { splitPlate, listSlicedPlates, readPrinterName, readThumbnails, verifySplit };
