import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planche, jpegDpi, lireJpegDpi, PLANCHE } from '../js/planche.js';
import { mmToPx } from '../js/norme.js';

test('planche 10×15 à 300 dpi : 1800×1200, 6 photos de 35×45 sans chevauchement, dans la feuille', () => {
  const p = planche(300);
  assert.equal(p.W, 1800); assert.equal(p.H, 1200);
  assert.equal(p.photos.length, 6);
  for (const a of p.photos) {
    assert.ok(Math.abs(a.w - mmToPx(35, 300)) <= 1 && Math.abs(a.h - mmToPx(45, 300)) <= 1);
    assert.ok(a.x > 0 && a.y > 0 && a.x + a.w < p.W && a.y + a.h < p.H);
    for (const b of p.photos) if (a !== b)
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'chevauchement');
  }
  // marges d'au moins 3 mm (les laboratoires rognent parfois un peu les bords)
  assert.ok(p.margeY >= mmToPx(3, 300) && p.margeX >= mmToPx(3, 300));
});

test('repères de coupe hors des photos', () => {
  const p = planche(300);
  for (const [x1, y1, x2, y2] of p.traits) for (const a of p.photos) {
    const inside = (x, y) => x > a.x + 0.5 && x < a.x + a.w - 0.5 && y > a.y + 0.5 && y < a.y + a.h - 0.5;
    assert.ok(!inside(x1, y1) && !inside(x2, y2) && !inside((x1 + x2) / 2, (y1 + y2) / 2));
  }
});

test('mode trio : une colonne par personne', () => {
  const p = planche(300, 'trio');
  assert.deepEqual(p.photos.map(x => x.source), [0, 1, 2, 0, 1, 2]);
  assert.deepEqual(planche(300).photos.map(x => x.source), [0, 0, 0, 0, 0, 0]);
  assert.equal(planche(600).W, 3600);
  assert.ok(PLANCHE.largeurMm > PLANCHE.hauteurMm);
});

test('jpegDpi : remplace la densité JFIF, ou insère un en-tête JFIF', () => {
  const jfif = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 72, 0, 72, 0, 0, 0xFF, 0xD9]);
  const a = jpegDpi(jfif, 300);
  assert.equal(lireJpegDpi(a), 300); assert.equal(a.length, jfif.length);
  const nu = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDB, 0, 4, 0, 0, 0xFF, 0xD9]);
  const b = jpegDpi(nu, 600);
  assert.equal(lireJpegDpi(b), 600); assert.equal(b.length, nu.length + 18);
  assert.deepEqual([...b.slice(-8)], [...nu.slice(2)]);
  assert.throws(() => jpegDpi(new Uint8Array([1, 2, 3]), 300));
});
