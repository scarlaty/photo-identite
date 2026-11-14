import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxBlur, resizeMask, hue, keyMap, removeIslands, contourBand, sharpen, estimateForeground, refine } from '../js/matte.js';

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('boxBlur conserve une image constante et la moyenne', () => {
  const w = 17, h = 9, src = new Float32Array(w * h).fill(0.7);
  for (const v of boxBlur(src, w, h, 4)) close(v, 0.7);
  const imp = new Float32Array(w * h); imp[4 * w + 8] = 1;
  const b = boxBlur(imp, w, h, 1);
  close(b[4 * w + 8], 1 / 9); close(b[3 * w + 7], 1 / 9); close(b[2 * w + 8], 0);
});

test('resizeMask : identité et valeurs bornées', () => {
  const src = Float32Array.from([0, 1, 1, 0]);
  assert.deepEqual([...resizeMask(src, 2, 2, 2, 2)], [0, 1, 1, 0]);
  const up = resizeMask(src, 2, 2, 8, 8);
  assert.equal(up.length, 64);
  for (const v of up) assert.ok(v >= 0 && v <= 1);
});

test('hue : couleurs primaires', () => {
  close(hue(255, 0, 0), 0); close(hue(0, 255, 0), 120); close(hue(0, 0, 255), 240);
  close(hue(56, 98, 188), 220.9, 0.1); // bleu du filet
});

test('keyMap : bleu du filet détecté, noir bleuté et peau ignorés', () => {
  // 5 pixels isolés sur une ligne espacée (dilatation 3×3 neutralisée par l'espacement)
  const px = [[56, 98, 188], [12, 14, 22], [200, 160, 140], [240, 200, 20], [60, 60, 60]];
  const w = px.length * 3, rgba = new Uint8ClampedArray(w * 4);
  px.forEach((c, i) => rgba.set([...c, 255], i * 3 * 4));
  // les pixels intermédiaires restent noirs (0,0,0) : chroma nulle
  const k = keyMap(rgba, w, 1, '#3862bc', 40);
  assert.ok(k[0] > 0.9, 'filet');
  assert.equal(k[3], 0, 'maillot noir bleuté');
  assert.equal(k[6], 0, 'peau');
  assert.equal(k[9], 0, 'jaune');
  assert.equal(k[12], 0, 'gris');
});

test('removeIslands : supprime une petite tache, garde le sujet', () => {
  const w = 40, h = 40, m = new Float32Array(w * h);
  for (let y = 5; y < 35; y++) for (let x = 5; x < 25; x++) m[y * w + x] = 1; // sujet 600 px
  m[2 * w + 37] = 1; m[2 * w + 38] = 1; // tache de 2 px
  const out = removeIslands(m, w, h, 0.02);
  assert.equal(out[2 * w + 37], 0);
  assert.equal(out[20 * w + 15], 1);
});

test('contourBand : vrai près du bord, faux loin du bord', () => {
  const w = 60, h = 20, m = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < 30; x++) m[y * w + x] = 1;
  const band = contourBand(m, w, h, 4);
  assert.equal(band[10 * w + 30], 1);
  assert.equal(band[10 * w + 2], 0);
  assert.equal(band[10 * w + 58], 0);
});

test('sharpen : 0 ne change rien, sinon reste dans [0,1] et monotone', () => {
  const m = Float32Array.from([0, 0.02, 0.5, 0.98, 1]);
  assert.equal(sharpen(m, 0), m);
  const s = sharpen(m, 50);
  for (let i = 1; i < s.length; i++) assert.ok(s[i] >= s[i - 1]);
  assert.equal(s[0], 0); assert.equal(s[4], 1);
});

test('estimateForeground : retire la couleur du fond des pixels de bord', () => {
  // Sujet rouge à gauche, fond bleu à droite, bord mélangé à 50 %.
  const w = 64, h = 8, rgba = new Uint8ClampedArray(w * h * 4), a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, al = x < 31 ? 1 : x === 31 ? 0.5 : 0;
    a[p] = al;
    rgba.set([255 * al, 0, 255 * (1 - al), 255], p * 4);
  }
  const out = estimateForeground(rgba, a, w, h, 0.1);
  const i = (4 * w + 31) * 4;
  assert.ok(out[i] > 200, `rouge conservé (${out[i]})`);
  assert.ok(out[i + 2] < 60, `bleu retiré (${out[i + 2]})`);
  assert.ok(out[i + 3] >= 127 && out[i + 3] <= 128, 'alpha conservé');
  // intérieur opaque inchangé
  const j = (4 * w + 5) * 4;
  assert.deepEqual([...out.slice(j, j + 4)], [255, 0, 0, 255]);
});

test('refine : une maille bleue collée au contour disparaît, le maillot bleu au centre reste', () => {
  const w = 120, h = 120, rgba = new Uint8ClampedArray(w * h * 4), mask = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, i = p * 4;
    const inBody = x >= 20 && x < 100 && y >= 20;
    const strand = x >= 100 && x < 103 && y >= 30 && y < 60;      // maille du filet collée au corps
    const logo = x >= 55 && x < 65 && y >= 60 && y < 70;          // logo bleu au milieu du maillot
    mask[p] = inBody || strand ? 1 : 0;                           // le modèle a gardé la maille
    if (strand || logo) rgba.set([56, 98, 188, 255], i);
    else if (inBody) rgba.set([20, 20, 20, 255], i);
    else rgba.set([200, 150, 90, 255], i);                        // bois
  }
  const out = refine(rgba, w, h, mask, w, h, { keyColor: '#3862bc' });
  assert.ok(out[(45 * w + 101) * 4 + 3] < 30, 'maille retirée');
  assert.equal(out[(65 * w + 60) * 4 + 3], 255, 'logo bleu conservé');
  assert.equal(out[(80 * w + 60) * 4 + 3], 255, 'corps conservé');
});

test('estimateForeground : cheveux opaques teintés par le fond au bord → teinte des cheveux', () => {
  // cas réel : le modèle juge opaques des mèches où le fond bleu transparaît (cheveux violets)
  const w = 60, h = 20, N = w * h, rgba = new Uint8ClampedArray(N * 4), a = new Float32Array(N);
  const roux = [190, 110, 60], bleu = [30, 60, 200], mix = roux.map((c, k) => Math.round(0.6 * c + 0.4 * bleu[k]));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, c = x < 15 ? roux : x < 25 ? mix : bleu;
    a[p] = x < 25 ? 1 : 0; rgba.set([...c, 255], p * 4);
  }
  const out = estimateForeground(rgba, a, w, h, 0.3);
  const i = (10 * w + 24) * 4;
  assert.ok(out[i] > out[i + 2] + 40, `rouge ${out[i]} nettement > bleu ${out[i + 2]} attendu`);
  const j = (10 * w + 3) * 4;   // intérieur (hors bande) inchangé
  assert.deepEqual([...out.slice(j, j + 3)], roux);
});

test('estimateForeground : maillot bleu opaque au bord, peau plus loin → couleur du maillot gardée', () => {
  // fond bleu-gris à droite ; sujet : peau à gauche (x < 10), maillot bleu de x = 10 à 39 ; bord net
  const w = 64, h = 24, N = w * h, rgba = new Uint8ClampedArray(N * 4), a = new Float32Array(N);
  const peau = [200, 150, 120], maillot = [40, 70, 200], fond = [48, 98, 188];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, c = x < 10 ? peau : x < 40 ? maillot : fond;
    a[p] = x < 40 ? 1 : 0; rgba.set([...c, 255], p * 4);
  }
  const out = estimateForeground(rgba, a, w, h, 0.1);
  const i = (12 * w + 38) * 4;   // maillot, au contour
  assert.ok(Math.abs(out[i] - 40) <= 8 && Math.abs(out[i + 2] - 200) <= 8, `maillot ${out[i]},${out[i + 1]},${out[i + 2]}`);
});
