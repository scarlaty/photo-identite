import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lumPx, lumZone, ecretage, nettete, appliquer, expositionAuto, temperatureAuto } from '../js/retouche.js';

test('luminance perçue : noir 0, blanc 1, gris moyen ≈ 0,5', () => {
  assert.equal(lumPx(0, 0, 0), 0);
  assert.ok(Math.abs(lumPx(255, 255, 255) - 1) < 1e-6);
  assert.ok(Math.abs(lumPx(128, 128, 128) - 128 / 255) < 0.01);
});

test('lumZone ignore les pixels transparents (fond détouré)', () => {
  const px = new Uint8ClampedArray([255, 255, 255, 0, 128, 128, 128, 255]);
  assert.ok(Math.abs(lumZone(px, 2, 1, 0, 0, 2, 1) - 128 / 255) < 0.01);
  assert.equal(lumZone(new Uint8ClampedArray([9, 9, 9, 0]), 1, 1, 0, 0, 1, 1), null);
});

test('netteté : image unie = 0, motif contrasté > 0', () => {
  assert.equal(nettete(new Float32Array(100).fill(.5), 10, 10), 0);
  const g = new Float32Array(100).map((_, i) => ((i % 10) + Math.floor(i / 10)) % 2);
  assert.ok(nettete(g, 10, 10) > 1);
});

test('appliquer : neutre = inchangé ; exposition +, plus clair ; pixels transparents intacts', () => {
  const base = new Uint8ClampedArray([100, 80, 60, 255, 10, 20, 30, 0]);
  assert.deepEqual([...appliquer(new Uint8ClampedArray(base), {})], [...base]);
  const p = appliquer(new Uint8ClampedArray(base), { exposition: .5 });
  assert.ok(p[0] > 100 && p[1] > 80 && p[2] > 60);
  assert.deepEqual([...p.slice(4)], [10, 20, 30, 0]);
  const s = appliquer(new Uint8ClampedArray(base), { saturation: -1 });
  assert.ok(Math.abs(s[0] - s[2]) <= 1, 'désaturé = gris');
  const c = appliquer(new Uint8ClampedArray(base), { temperature: 1 });
  assert.ok(c[0] > p[0] - 100 && c[0] >= base[0] && c[2] <= base[2], 'plus chaud : plus de rouge, moins de bleu');
});

test('réglages automatiques bornés et de bon sens', () => {
  assert.ok(expositionAuto(0.1) > 0); assert.ok(expositionAuto(0.9) < 0);
  // dans la plage acceptable : on ne touche pas (peaux claires comme foncées)
  for (const l of [0.25, 0.3, 0.45, 0.58, 0.7]) assert.equal(expositionAuto(l), 0);
  assert.ok(expositionAuto(0.01) <= 0.8 && expositionAuto(0.99) >= -0.8);
  assert.ok(temperatureAuto(200, 100) < 0, 'peau trop rouge → plus froid');
  assert.ok(temperatureAuto(120, 110) > 0, 'peau trop bleue → plus chaud');
});

test('écrêtage : part des pixels brûlés et bouchés, pixels transparents ignorés', () => {
  const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 0]);
  const e = ecretage(px, 4, 1, 0, 0, 4, 1);
  assert.ok(Math.abs(e.brule - 1 / 3) < 1e-9 && Math.abs(e.bouche - 1 / 3) < 1e-9);
});
