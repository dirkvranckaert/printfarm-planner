const { normalizeHex, normalizeKey, matchFilament, enrichColorsFromCatalog } = require('../filament-match');

const fil = (id, brand, colorName, hex, inStock = 1, type = 'PLA') => ({
  id, brand, colorName, type, variant: 'Basic', inStock, colorHex: hex,
});

describe('normalizeHex', () => {
  test('lowercases and adds # prefix', () => {
    expect(normalizeHex('FFAABB')).toBe('#ffaabb');
    expect(normalizeHex('#FFAABB')).toBe('#ffaabb');
    expect(normalizeHex('  ffaabb  ')).toBe('#ffaabb');
  });
  test('expands 3-char shorthand', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('abc')).toBe('#aabbcc');
  });
  test('rejects garbage', () => {
    expect(normalizeHex('not-a-color')).toBeNull();
    expect(normalizeHex('')).toBeNull();
    expect(normalizeHex(null)).toBeNull();
  });
});

describe('normalizeKey', () => {
  test('matches "Bambu Lab" / "Bambulab" / "bambu-lab"', () => {
    const a = normalizeKey('Bambu Lab');
    const b = normalizeKey('Bambulab');
    const c = normalizeKey('bambu-lab');
    const d = normalizeKey('  BAMBU_LAB ');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(c).toBe(d);
  });
});

describe('matchFilament', () => {
  test('returns null when no hex match', () => {
    const cat = [fil(1, 'X', 'Red', '#ff0000')];
    expect(matchFilament({ color: '#00ff00' }, cat)).toBeNull();
  });

  test('returns the only candidate when hex matches once', () => {
    const cat = [fil(1, 'X', 'Red', '#ff0000')];
    expect(matchFilament({ color: '#FF0000' }, cat).id).toBe(1);
  });

  test('tier 1: prefers brand+type match over brand-only', () => {
    const cat = [
      fil(1, 'Bambu Lab', 'White',     '#ffffff', 1, 'PLA'),
      fil(2, 'Bambu Lab', 'Snowwhite', '#ffffff', 1, 'PETG'),
    ];
    const got = matchFilament({ color: '#ffffff', brand: 'Bambulab', type: 'PETG' }, cat);
    expect(got.id).toBe(2);
  });

  test('tier 1: prefers brand-only match over no match', () => {
    const cat = [
      fil(1, 'Generic',   'Pure White', '#ffffff'),
      fil(2, 'Bambu Lab', 'Jade White', '#ffffff'),
    ];
    const got = matchFilament({ color: '#ffffff', brand: 'Bambulab' }, cat);
    expect(got.id).toBe(2);
  });

  test('tier 2: in-stock wins when discriminator counts tie', () => {
    const cat = [
      fil(1, 'X', 'Snow',  '#ffffff', 0),
      fil(2, 'X', 'Cream', '#ffffff', 1),
    ];
    const got = matchFilament({ color: '#ffffff' }, cat);
    expect(got.id).toBe(2);
  });

  test('tier 3: lowest id wins when discriminator and stock tie', () => {
    const cat = [
      fil(7, 'X', 'White-A', '#ffffff', 1),
      fil(3, 'X', 'White-B', '#ffffff', 1),
      fil(9, 'X', 'White-C', '#ffffff', 1),
    ];
    const got = matchFilament({ color: '#ffffff' }, cat);
    expect(got.id).toBe(3);
  });

  test('brand normalization: "Bambu Lab" matches "Bambulab"', () => {
    const cat = [
      fil(1, 'Generic',  'Generic Black', '#000000'),
      fil(2, 'Bambulab', 'Bambu Black',   '#000000'),
    ];
    const got = matchFilament({ color: '#000000', brand: 'Bambu Lab' }, cat);
    expect(got.id).toBe(2);
  });

  test('REGRESSION (production): #000000 with brand=Bambu Lab and 5 candidates → in-stock Bambulab Black', () => {
    // Mirrors the dry-run report: 5 black rows in filament-manager, payload
    // brand "Bambu Lab". Expected: an in-stock Bambulab row, not the
    // out-of-stock or non-Bambulab one.
    const cat = [
      fil(1, 'Bambulab', 'Black',     '#000000', 1),
      fil(2, 'Bambulab', 'Black',     '#000000', 1),
      fil(3, 'Bambulab', 'Black',     '#000000', 1),
      fil(4, 'Bambulab', 'Charcoal',  '#000000', 1),
      fil(5, 'OtherBrand', 'Black',   '#000000', 0),
    ];
    const got = matchFilament({ color: '#000000', brand: 'Bambu Lab' }, cat);
    expect(got.id).toBe(1);   // first Bambulab Black, in-stock, lowest id
    expect(got.brand).toBe('Bambulab');
    expect(got.colorName).toBe('Black');
  });

  test('REGRESSION (production): #ffffff with brand=Bambu Lab and 4 candidates → in-stock Bambulab', () => {
    const cat = [
      fil(1, 'Bambulab', 'Jade White', '#ffffff', 1),
      fil(2, 'Bambulab', 'White',      '#ffffff', 1),
      fil(3, 'Bambulab', 'Snowwhite',  '#ffffff', 0),
      fil(4, 'Bambulab', 'Snowwhite',  '#ffffff', 0),
    ];
    const got = matchFilament({ color: '#ffffff', brand: 'Bambu Lab' }, cat);
    expect(got.id).toBe(1);   // both 1 and 2 are tied on b+(no t)+inStock; lowest id wins
    expect(got.colorName).toBe('Jade White');
  });
});

describe('enrichColorsFromCatalog', () => {
  test('replaces matched names + brand and reports replacements', () => {
    const colors = [
      { color: '#ae835b', name: 'Limed Oak', brand: 'Bambu Lab' },
      { color: '#623e2a', name: 'Quincy',    brand: 'Bambu Lab' },
      { color: '#zzzzzz', name: 'Bogus',     brand: '' }, // garbage hex
    ];
    const catalog = [
      fil(1, 'Bambulab', 'Caramel',     '#ae835b', 1),
      fil(2, 'Bambulab', 'Earth Brown', '#623e2a', 1),
    ];
    const report = enrichColorsFromCatalog(colors, catalog);
    expect(report.matched).toBe(2);
    expect(report.total).toBe(3);
    expect(report.replacements).toHaveLength(2);
    expect(colors[0].name).toBe('Caramel');
    expect(colors[0].brand).toBe('Bambulab');
    expect(colors[1].name).toBe('Earth Brown');
    expect(colors[2].name).toBe('Bogus'); // unchanged — no match
  });

  test('does not report a "replacement" when the existing name already matches', () => {
    const colors = [{ color: '#ffffff', name: 'Jade White', brand: 'Bambulab' }];
    const catalog = [fil(1, 'Bambulab', 'Jade White', '#ffffff', 1)];
    const report = enrichColorsFromCatalog(colors, catalog);
    expect(report.matched).toBe(1);
    expect(report.replacements).toHaveLength(0);
  });
});
