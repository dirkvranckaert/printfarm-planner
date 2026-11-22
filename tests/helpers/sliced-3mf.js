// Builds a synthetic multi-plate sliced .gcode.3mf (Bambu layout) for the plate-split
// tests, using the production ZipWriter. Each plate N gets distinguishable content
// (gcode text, time, weight) so a split can be checked plate by plate.
const { ZipWriter } = require('../../zip-lite');

const rel = n => `<Relationship Target="/Metadata/plate_${n}.gcode" Id="rel-${n}" Type="http://schemas.bambulab.com/package/2021/gcode"/>`;

async function buildSliced3mf(destPath, plateCount = 3, { h2c = true, extra = {} } = {}) {
  const w = new ZipWriter(destPath);
  const add = (name, content) => w.addBuffer(name, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  const range = Array.from({ length: plateCount }, (_, i) => i + 1);

  await add('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  await add('Metadata/project_settings.config', JSON.stringify({ printer_model: h2c ? 'Bambu Lab H2C' : 'Bambu Lab P1S' }));
  await add('Metadata/slice_info.config',
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'
    + range.map(n => `  <plate>\n    <metadata key="index" value="${n}"/>\n    <metadata key="prediction" value="${n * 600}"/>\n    <metadata key="weight" value="${n * 10}.5"/>\n    <object identify_id="${n}" name="Obj ${n}" skipped="false"/>\n    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#00${n}000" used_m="1.00" used_g="${n}.0"/>\n  </plate>\n`).join('')
    + '</config>');
  await add('Metadata/model_settings.config',
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'
    + range.map(n => `  <plate>\n    <metadata key="plater_id" value="${n}"/>\n    <metadata key="plater_name" value="Plate name ${n}"/>\n    <metadata key="thumbnail_file" value="Metadata/plate_${n}.png"/>\n    <metadata key="top_file" value="Metadata/top_${n}.png"/>\n    <metadata key="pick_file" value="Metadata/pick_${n}.png"/>\n  </plate>\n`).join('')
    + '</config>');
  await add('Metadata/_rels/model_settings.config.rels',
    '<?xml version="1.0"?>\n<Relationships>\n' + range.map(rel).join('\n') + '\n</Relationships>');
  if (h2c) {
    await add('Metadata/custom_gcode_per_layer.xml',
      '<?xml version="1.0"?>\n<custom_gcodes_per_layer>\n'
      + range.map(n => `<plate>\n<plate_info id="${n}"/>\n<layer top_z="${n}.2" type="2" extruder="1" color="#FF0000"/>\n</plate>\n`).join('')
      + '</custom_gcodes_per_layer>');
  }
  await add('Metadata/filament_sequence.json', JSON.stringify(Object.fromEntries(range.map(n => [`plate_${n}`, { sequence: [n] }]))));
  for (const n of range) {
    await add(`Metadata/plate_${n}.gcode`, `; plate ${n}\n` + 'G1 X1 Y1\n'.repeat(50 * n));
    await add(`Metadata/plate_${n}.gcode.md5`, `md5-of-plate-${n}`);
    await add(`Metadata/plate_${n}.png`, Buffer.alloc(200, n));
    await add(`Metadata/plate_${n}.json`, JSON.stringify({ plate: n }));
    await add(`Metadata/top_${n}.png`, Buffer.alloc(120, n));
    await add(`Metadata/pick_${n}.png`, Buffer.alloc(120, n));
  }
  for (const [name, content] of Object.entries(extra)) await add(name, content);
  await w.finish();
}

module.exports = { buildSliced3mf };
