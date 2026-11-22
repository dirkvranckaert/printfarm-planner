'use strict';

/**
 * Minimal streaming ZIP reader/writer (no dependencies) for splitting sliced
 * 3MF archives on disk.
 *
 *  - Reader: parses the central directory only (reads the file tail), so a
 *    100 MB archive costs a few KB of memory. Entry data is read on demand.
 *  - Writer: appends entries to an output file. `addRaw` copies an entry's
 *    still-compressed bytes straight from the source (no inflate/deflate, CRC
 *    and sizes reused), `addBuffer` deflates a small in-memory entry.
 *
 * ZIP64 (archives/entries >= 4 GiB or >= 65535 entries) is NOT supported and
 * throws, which the caller turns into "Split failed" (original stays usable).
 */

const fs = require('fs');
const zlib = require('zlib');
const { once } = require('events');

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const MAX_EDIT_BYTES = 32 * 1024 * 1024; // entries we inflate into memory (configs, never gcode)
const MAX_DEFLATE_SLACK = 1024 * 1024; // deflate may expand incompressible data slightly
// Independent fixed caps on the central directory, which is read whole into memory.
// Real Bambu archives have 70-90 entries / ~5-6 KB of directory (measured on real
// multi-plate exports); 4 MiB / 10000 entries is ~700x / ~100x headroom and still a
// trivially small allocation, whatever the (attacker-controlled) file size is.
const MAX_CD_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 10000;

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Every length/offset read from an archive is attacker-declared: bound the range
// against the real file size BEFORE allocating, so a tiny zip can't ask for GiBs.
async function readAt(fh, position, length, fileSize) {
  if (!Number.isInteger(length) || length < 0 || position < 0 || position + length > fileSize) {
    throw new Error('Zip range outside file');
  }
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new Error('Unexpected end of zip file');
  return buf;
}

/** Open a zip and return { fh, entries, byName, close }. */
async function openZip(filePath) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new Error('Not a zip file');
    const tailLen = Math.min(size, 22 + 65535);
    const tail = await readAt(fh, size - tailLen, tailLen, size);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { e = i; break; }
    }
    if (e < 0) throw new Error('Not a zip file (no end-of-central-directory)');
    const count = tail.readUInt16LE(e + 10);
    const cdSize = tail.readUInt32LE(e + 12);
    const cdOffset = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported');
    }
    if (cdOffset + cdSize > size || count * 46 > cdSize) throw new Error('Corrupt zip central directory');
    if (cdSize > MAX_CD_BYTES || count > MAX_ENTRIES) throw new Error('Zip central directory too large');
    const cd = await readAt(fh, cdOffset, cdSize, size);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CEN) throw new Error('Corrupt zip central directory');
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new Error('Corrupt zip central directory');
      const entry = {
        flags: cd.readUInt16LE(p + 8),
        method: cd.readUInt16LE(p + 10),
        time: cd.readUInt16LE(p + 12),
        date: cd.readUInt16LE(p + 14),
        crc: cd.readUInt32LE(p + 16),
        csize: cd.readUInt32LE(p + 20),
        usize: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
        name: cd.toString('utf8', p + 46, p + 46 + nameLen),
      };
      if (entry.csize === 0xffffffff || entry.usize === 0xffffffff || entry.offset === 0xffffffff) {
        throw new Error('ZIP64 entries are not supported');
      }
      entries.push(entry);
      p += 46 + nameLen + extraLen + commentLen;
    }
    const byName = new Map(entries.map(en => [en.name, en]));
    return { fh, size, entries, byName, close: () => fh.close() };
  } catch (err) {
    await fh.close();
    throw err;
  }
}

/** Absolute offset of an entry's (compressed) data. */
async function dataOffset(zip, entry) {
  const loc = await readAt(zip.fh, entry.offset, 30, zip.size);
  if (loc.readUInt32LE(0) !== SIG_LOC) throw new Error(`Corrupt local header for ${entry.name}`);
  return entry.offset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
}

/** Read + inflate a (small) entry into a Buffer. */
async function readEntry(zip, entry) {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`Unsupported compression method ${entry.method} for ${entry.name}`);
  }
  if (entry.usize > MAX_EDIT_BYTES || entry.csize > MAX_EDIT_BYTES + MAX_DEFLATE_SLACK) {
    throw new Error(`Entry too large to edit: ${entry.name}`);
  }
  if (entry.method === 0 && entry.csize !== entry.usize) throw new Error(`Size mismatch for ${entry.name}`);
  const raw = await readAt(zip.fh, await dataOffset(zip, entry), entry.csize, zip.size);
  if (entry.method === 0) return raw;
  {
    // usize is attacker-declared: cap the inflate so a lying entry can't balloon memory.
    const out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(entry.usize, MAX_EDIT_BYTES)) });
    if (out.length !== entry.usize) throw new Error(`Size mismatch for ${entry.name}`);
    return out;
  }
}

/** Convenience: read one named entry from a zip path; null when absent. */
async function readNamed(filePath, name) {
  const zip = await openZip(filePath);
  try {
    const entry = zip.byName.get(name);
    return entry ? await readEntry(zip, entry) : null;
  } finally { await zip.close(); }
}

/** Streaming ZIP writer. */
class ZipWriter {
  constructor(destPath) {
    this.ws = fs.createWriteStream(destPath);
    this.pos = 0;
    this.central = [];
    this.failed = null;
    this.ws.on('error', err => { this.failed = err; });
  }

  async _write(buf) {
    if (this.failed) throw this.failed;
    this.pos += buf.length;
    if (!this.ws.write(buf)) await once(this.ws, 'drain');
    if (this.failed) throw this.failed;
  }

  _local(name, e) {
    const nameBuf = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(30 + nameBuf.length);
    h.writeUInt32LE(SIG_LOC, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6); // UTF-8 names, sizes known up front (no data descriptor)
    h.writeUInt16LE(e.method, 8);
    h.writeUInt16LE(e.time, 10);
    h.writeUInt16LE(e.date, 12);
    h.writeUInt32LE(e.crc, 14);
    h.writeUInt32LE(e.csize, 18);
    h.writeUInt32LE(e.usize, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    nameBuf.copy(h, 30);
    this.central.push({ ...e, name: nameBuf, offset: this.pos });
    return h;
  }

  /** Copy an entry's compressed bytes from `srcZip` unchanged, optionally renamed. */
  async addRaw(srcZip, entry, newName = entry.name) {
    await this._write(this._local(newName, entry));
    const start = await dataOffset(srcZip, entry);
    if (start + entry.csize > srcZip.size) throw new Error(`Entry data outside file: ${entry.name}`);
    if (entry.csize > 0) {
      const rs = fs.createReadStream(null, { fd: srcZip.fh.fd, start, end: start + entry.csize - 1, autoClose: false, emitClose: false });
      for await (const chunk of rs) await this._write(chunk);
    }
  }

  /** Add a small in-memory entry (deflated). */
  async addBuffer(name, buf, like) {
    const comp = zlib.deflateRawSync(buf);
    const e = { method: 8, time: like?.time ?? 0, date: like?.date ?? 0x21, crc: crc32(buf), csize: comp.length, usize: buf.length };
    await this._write(this._local(name, e));
    await this._write(comp);
  }

  async finish() {
    const cdStart = this.pos;
    for (const c of this.central) {
      const h = Buffer.alloc(46 + c.name.length);
      h.writeUInt32LE(SIG_CEN, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(c.time, 12);
      h.writeUInt16LE(c.date, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.csize, 20);
      h.writeUInt32LE(c.usize, 24);
      h.writeUInt16LE(c.name.length, 28);
      h.writeUInt32LE(c.offset, 42);
      c.name.copy(h, 46);
      await this._write(h);
    }
    const cdSize = this.pos - cdStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_EOCD, 0);
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    await this._write(end);
    this.ws.end();
    await once(this.ws, 'close');
    if (this.failed) throw this.failed;
  }

  abort() { this.ws.destroy(); }
}

module.exports = { openZip, readEntry, readNamed, ZipWriter, crc32 };
