import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conseils, GUIDE } from '../js/guide.js';
import { LM, NORME } from '../js/norme.js';

/** Visage de face sur une image W×H : yeux en (cx, eyeY), yeux→menton = d. */
function vue({ W = 1080, H = 1440, cx = 540, eyeY = 650, d = 340, roulisDeg = 0, nezDx = 0, blend = {}, lum = 0.5, asym = 1.05, nb = 1 } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: cx / W, y: eyeY / H, z: 0 }));
  const a = roulisDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const put = (i, dx, dy) => { lm[i] = { x: (cx + dx * ca - dy * sa) / W, y: (eyeY + dx * sa + dy * ca) / H, z: 0 }; };
  put(LM.irisD, -0.33 * d, 0); put(LM.irisG, 0.33 * d, 0);
  put(LM.menton, 0, d); put(LM.nez, nezDx, 0.45 * d);
  put(LM.joueD, -0.7 * d, 0.3 * d); put(LM.joueG, 0.7 * d, 0.3 * d);
  return { nb, lm, blend, W, H, lum, asym };
}
const ko = v => conseils(v).items.filter(x => !x.ok).map(x => x.id);

test('bien placé : tout est bon, déclenchement possible', () => {
  const g = conseils(vue());
  assert.equal(g.ok, true, JSON.stringify(g.items));
  assert.equal(g.message, 'Parfait, ne bouge plus');
});

test('chaque défaut produit son conseil', () => {
  assert.deepEqual(conseils(vue({ nb: 0 })).ok, false);
  assert.match(conseils(vue({ nb: 2 })).message, /seule personne/);
  assert.deepEqual(ko(vue({ d: 150, eyeY: 500 })), ['distance']);
  assert.match(conseils(vue({ d: 150, eyeY: 500 })).message, /Approche/);
  assert.match(conseils(vue({ eyeY: 380 })).message, /Baisse/);          // pas de place pour les cheveux
  assert.match(conseils(vue({ eyeY: 900 })).message, /Monte/);           // épaules coupées
  assert.match(conseils(vue({ d: 500, eyeY: 720 })).message, /Recule/);
  assert.deepEqual(ko(vue({ cx: 800 })), ['centre']);
  assert.deepEqual(ko(vue({ roulisDeg: 7 })), ['droite']);
  assert.deepEqual(ko(vue({ nezDx: 60 })), ['face']);
  assert.deepEqual(ko(vue({ blend: { eyeBlinkLeft: 0.6 } })), ['yeux']);
  assert.deepEqual(ko(vue({ blend: { mouthSmileRight: 0.5 } })), ['neutre']);
  assert.deepEqual(ko(vue({ blend: { jawOpen: 0.3 } })), ['neutre']);
  assert.deepEqual(ko(vue({ lum: 0.1 })), ['lumiere']);
  assert.deepEqual(ko(vue({ lum: 0.92 })), ['lumiere']);
  assert.deepEqual(ko(vue({ asym: 1.6 })), ['ombre']);
});

test('seuil de distance cohérent avec 300 dpi utiles', () => {
  // hauteur de tête = (1 + craneSurMenton) × yeux→menton ; visage cible à 300 dpi
  assert.ok((1 + NORME.craneSurMenton) * GUIDE.yeuxMentonMin >= NORME.visageCibleMm / 25.4 * 300 - 1e-9);
});
