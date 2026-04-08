'use strict';

/**
 * Parse a BambuLab/OrcaSlicer 3MF file and extract plate data.
 *
 * 3MF files are ZIP archives. Sliced 3MFs contain:
 *   Metadata/slice_info.config      — XML with per-plate print time, weight, filaments
 *   Metadata/plate_N.json           — per-plate metadata (object names, bbox)
 *   Metadata/project_settings.config — JSON with filament vendors, costs, types
 *   Metadata/model_settings.config  — XML with plate names
 *
 * Un-sliced 3MFs have limited data (no print time or weight).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Extract a file from a ZIP archive. Returns string or null.
 */
function extractFile(zipPath, innerPath) {
  try {
    return execSync(
      `unzip -p "${zipPath}" "${innerPath}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10000 }
    );
  } catch { return null; }
}

/**
 * Extract a binary file from a ZIP archive. Returns Buffer or null.
 */
function extractBinary(zipPath, innerPath) {
  try {
    return execSync(
      `unzip -p "${zipPath}" "${innerPath}" 2>/dev/null`,
      { timeout: 10000 }
    );
  } catch { return null; }
}

/**
 * Extract thumbnail images from a 3MF file.
 * Returns array of { plateIndex, buffer, filename } for each plate_N.png found.
 */
function extractThumbnails(input) {
  let filePath;
  let tempFile = null;
  if (Buffer.isBuffer(input)) {
    tempFile = path.join(require('os').tmpdir(), `thumb3mf_${Date.now()}.3mf`);
    fs.writeFileSync(tempFile, input);
    filePath = tempFile;
  } else {
    filePath = input;
  }
  try {
    const thumbnails = [];
    for (let i = 1; i <= 20; i++) {
      const buf = extractBinary(filePath, `Metadata/plate_${i}.png`);
      if (!buf || buf.length < 100) break;
      thumbnails.push({ plateIndex: i, buffer: buf, filename: `plate_${i}.png` });
    }
    return thumbnails;
  } finally {
    if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

/**
 * Parse a 3MF file buffer or path.
 * @param {string|Buffer} input — file path or Buffer
 * @returns {object}
 */
function parse3mf(input) {
  let filePath;
  let tempFile = null;

  if (Buffer.isBuffer(input)) {
    tempFile = path.join(require('os').tmpdir(), `parse3mf_${Date.now()}.3mf`);
    fs.writeFileSync(tempFile, input);
    filePath = tempFile;
  } else {
    filePath = input;
  }

  try {
    const result = { plates: [], sliced: false, filamentProfiles: [] };

    // --- Extract project_settings.config (JSON) for filament vendor/cost/type ---
    const projSettingsRaw = extractFile(filePath, 'Metadata/project_settings.config');
    let projSettings = null;
    if (projSettingsRaw) {
      try { projSettings = JSON.parse(projSettingsRaw); } catch { /* not JSON */ }
    }

    if (projSettings) {
      result.printerName = projSettings.printer_model || null;
      result.printerVariant = projSettings.printer_variant || null;

      const vendors = projSettings.filament_vendor || [];
      const types = projSettings.filament_type || [];
      const costs = projSettings.filament_cost || [];
      const colors = projSettings.filament_colour || [];
      const densities = projSettings.filament_density || [];
      const count = Math.max(vendors.length, types.length);
      for (let i = 0; i < count; i++) {
        result.filamentProfiles.push({
          index: i + 1,
          vendor: vendors[i] || null,
          type: types[i] || null,
          cost: parseFloat(costs[i]) || 0,
          color: colors[i] || null,
          density: parseFloat(densities[i]) || 0,
        });
      }
    }

    // --- Extract model_settings.config for plate names ---
    const plateNames = {};
    const modelSettingsXml = extractFile(filePath, 'Metadata/model_settings.config');
    if (modelSettingsXml) {
      const plateBlocks = modelSettingsXml.split('<plate>').slice(1);
      for (const block of plateBlocks) {
        let id = null, name = null;
        const metaRegex = /<metadata key="([^"]+)" value="([^"]*)"/g;
        let m;
        while ((m = metaRegex.exec(block)) !== null) {
          if (m[1] === 'plater_id') id = parseInt(m[2]);
          if (m[1] === 'plater_name') name = m[2] || null;
        }
        if (id && name) plateNames[id] = name;
      }
    }

    // --- Extract slice_info.config (only present in sliced 3MFs) ---
    const sliceInfoXml = extractFile(filePath, 'Metadata/slice_info.config');
    if (sliceInfoXml && sliceInfoXml.includes('<plate>')) {
      result.sliced = true;
      result.plates = parseSliceInfo(sliceInfoXml);
    }

    // --- Extract plate_N.json files for object names ---
    for (let i = 1; i <= 20; i++) {
      const json = extractFile(filePath, `Metadata/plate_${i}.json`);
      if (!json) break;
      let data;
      try { data = JSON.parse(json); } catch { continue; }

      const objects = (data.bbox_objects || [])
        .filter(o => !o.name?.includes('wipe_tower'))
        .map(o => o.name);

      if (result.plates[i - 1]) {
        if (!result.plates[i - 1].objects.length) {
          result.plates[i - 1].objects = objects;
        }
        result.plates[i - 1].plateName = plateNames[i] || null;
        result.plates[i - 1].bedType = data.bed_type || null;
      } else if (!result.sliced) {
        result.plates.push({
          index: i,
          plateName: plateNames[i] || null,
          printTimeSeconds: 0,
          printTimeMinutes: 0,
          weightGrams: 0,
          objects,
          filaments: [],
          layerHeight: data.bbox_objects?.[0]?.layer_height || null,
          bedType: data.bed_type || null,
        });
      }
    }

    // --- Compute summary per plate ---
    for (const plate of result.plates) {
      // Determine dominant filament type (are all the same or mixed?)
      const types = [...new Set(plate.filaments.map(f => f.type).filter(Boolean))];
      plate.filamentType = types.length === 1 ? types[0] : (types.length > 1 ? 'Mixed' : null);
      plate.filamentTypes = types;

      // Try to match vendor from filament profiles
      const vendorSet = new Set();
      for (const f of plate.filaments) {
        const profile = result.filamentProfiles[f.id - 1];
        if (profile?.vendor && profile.vendor !== 'Generic') vendorSet.add(profile.vendor);
      }
      plate.filamentVendors = [...vendorSet];

      // Object count (items on plate, excluding wipe tower)
      plate.objectCount = plate.objects.length;
    }

    return result;
  } finally {
    if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

/**
 * Parse the slice_info.config XML (BambuLab/OrcaSlicer format).
 */
function parseSliceInfo(xml) {
  const plates = [];
  const plateBlocks = xml.split('<plate>').slice(1);

  for (const block of plateBlocks) {
    const plate = {
      index: 0,
      plateName: null,
      printTimeSeconds: 0,
      printTimeMinutes: 0,
      weightGrams: 0,
      objects: [],
      filaments: [],
      printerModel: null,
    };

    const metaRegex = /<metadata key="([^"]+)" value="([^"]*)"/g;
    let match;
    while ((match = metaRegex.exec(block)) !== null) {
      const [, key, value] = match;
      switch (key) {
        case 'index':
          plate.index = parseInt(value) || 0;
          break;
        case 'prediction':
          plate.printTimeSeconds = parseInt(value) || 0;
          plate.printTimeMinutes = Math.round(plate.printTimeSeconds / 60 * 100) / 100;
          break;
        case 'weight':
          plate.weightGrams = parseFloat(value) || 0;
          break;
        case 'printer_model_id':
          plate.printerModel = value;
          break;
      }
    }

    const objRegex = /<object[^>]+name="([^"]+)"[^>]*\/>/g;
    while ((match = objRegex.exec(block)) !== null) {
      plate.objects.push(match[1]);
    }

    const filRegex = /<filament([^>]+)\/>/g;
    while ((match = filRegex.exec(block)) !== null) {
      const attrs = match[1];
      const get = (key) => {
        const m = attrs.match(new RegExp(`${key}="([^"]*)"`));
        return m ? m[1] : null;
      };
      plate.filaments.push({
        id: parseInt(get('id')) || 0,
        type: get('type'),
        color: get('color'),
        usedGrams: parseFloat(get('used_g')) || 0,
        usedMeters: parseFloat(get('used_m')) || 0,
      });
    }

    plates.push(plate);
  }

  return plates;
}

module.exports = { parse3mf, extractThumbnails };
