import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NORME, SEUILS, LM, reperes, cadre, mesures, controles, taillePhoto, fondConforme, FONDS, resolution, lacet, borneCrane } from '../js/norme.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/** Faux maillage : 478 points, visage de face, centré en (cx, cy) px, yeux→menton = d px. */
function visage({ W = 3000, H = 4000, cx = 1500, eyeY = 1600, d = 300, roulisDeg = 0, nezDx = 0 } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: cx / W, y: eyeY / H, z: 0 }));
  const a = roulisDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const put = (i, dx, dy) => { lm[i] = { x: (cx + dx * ca - dy * sa) / W, y: (eyeY + dx * sa + dy * ca) / H, z: 0 }; };
  put(LM.irisD, -0.33 * d, 0); put(LM.irisG, 0.33 * d, 0);
  put(LM.menton, 0, d); put(LM.nez, nezDx, 0.45 * d);
  put(LM.joueD, -0.7 * d, 0.3 * d); put(LM.joueG, 0.7 * d, 0.3 * d);
  put(LM.pommetteD, -0.4 * d, 0.4 * d); put(LM.pommetteG, 0.4 * d, 0.4 * d);
  return { lm, W, H };
}

test('format 35×45 à 600 dpi', () => {
  assert.deepEqual(taillePhoto(600), [827, 1063]);
  assert.deepEqual(taillePhoto(300), [413, 531]);
});

test('repères : roulis, hauteur de tête = 2 × (yeux → menton)', () => {
  const { lm, W, H } = visage({ d: 300, roulisDeg: 5 });
  const r = reperes(lm, W, H);
  close(r.roulis, 5, 1e-6);
  close(r.yeuxMenton, 300, 1e-6);
  close(r.hauteurTete, 600, 1e-6);
});

test('cadre : visage de 34 mm, yeux dans la zone 50–70 %, centré, quelle que soit la taille source', () => {
  for (const d of [150, 300, 900]) {
    const { lm, W, H } = visage({ d });
    const r = reperes(lm, W, H), c = cadre(r), m = mesures(r, c);
    close(m.visageMm, NORME.visageCibleMm, 1e-9);
    assert.ok(m.yeuxRatioBas >= NORME.yeuxBasMin && m.yeuxRatioBas <= NORME.yeuxBasMax, `yeux ${m.yeuxRatioBas}`);
    close(m.centreX, NORME.largeurMm / 2, 1e-9);
    close(m.craneMm, NORME.crane_haut_mm, 1e-9);
    assert.ok(m.mentonMm < NORME.hauteurMm - 1);
    close(c.w / c.h, 35 / 45, 1e-9);
  }
});

test('cadre : le zoom change la taille du visage, les décalages déplacent le cadre', () => {
  const { lm, W, H } = visage();
  const r = reperes(lm, W, H);
  close(mesures(r, cadre(r, { zoom: NORME.visageCibleMm / 32 })).visageMm, 32, 1e-9);
  close(mesures(r, cadre(r, { dx: 1 })).centreX, 17.5 + 1, 1e-9);
  close(mesures(r, cadre(r, { dy: 1 })).craneMm, NORME.crane_haut_mm + 1, 1e-9);
});

test('contrôles : photo conforme → tout vert', () => {
  const { lm, W, H } = visage({ d: 700 });
  const r = reperes(lm, W, H), c = cadre(r);
  const res = controles({ nbVisages: 1, r, c, blend: { eyeBlinkLeft: .05, eyeBlinkRight: .05, jawOpen: .01, mouthSmileLeft: .05, mouthSmileRight: .05 },
    lumPeau: .58, asym: 1.05, nettete: 80, fond: FONDS['gris-clair'].hex });
  const ko = res.filter(x => x.ok === false);
  assert.deepEqual(ko, []);
});

test('contrôles : chaque défaut est signalé', () => {
  const { lm, W, H } = visage({ d: 60, roulisDeg: 12, nezDx: 40 });  // visage minuscule : < 200 dpi utiles
  const r = reperes(lm, W, H), c = cadre(r, { zoom: 1.2 });
  const res = controles({ nbVisages: 1, r, c, blend: { eyeBlinkLeft: .8, jawOpen: .3, mouthSmileLeft: .6 }, lumPeau: .5, brule: .2, asym: 1.6, nettete: 5, fond: '#FFFFFF' });
  const ko = new Set(res.filter(x => x.ok === false).map(x => x.id));
  for (const id of ['taille-visage', 'tete-droite', 'face', 'yeux-ouverts', 'bouche-fermee', 'neutre', 'exposition', 'ombre', 'nettete', 'fond', 'resolution'])
    assert.ok(ko.has(id), `défaut non signalé : ${id}`);
  assert.equal(controles({ nbVisages: 2 }).find(x => x.id === 'visage-unique').ok, false);
});

test('fond : couleurs proposées conformes, blanc et couleurs vives refusés', () => {
  for (const f of Object.values(FONDS)) assert.ok(fondConforme(f.hex).ok, f.nom);
  assert.equal(fondConforme('#FFFFFF').ok, false);
  assert.equal(fondConforme('#F8F8F8').ok, false);
  assert.equal(fondConforme('#3366FF').ok, false);
  assert.equal(fondConforme('#333333').ok, false);
});

test('résolution et lacet', () => {
  const { lm, W, H } = visage({ d: 300 });
  const r = reperes(lm, W, H), c = cadre(r);
  close(resolution(c, 600).ratio, (600 / NORME.visageCibleMm) / (600 / 25.4), 1e-9);
  close(lacet(r), 0.5, 1e-9);
  assert.ok(SEUILS.lacetEcart > 0);
});

test('peau foncée bien exposée : acceptée, non signalée comme sous-exposée', () => {
  const { lm, W, H } = visage({ d: 700 });
  const r = reperes(lm, W, H), c = cadre(r);
  for (const lumPeau of [0.26, 0.30, 0.36]) {
    const e = controles({ nbVisages: 1, r, c, lumPeau, brule: 0, bouche: 0.005 }).find(x => x.id === 'exposition');
    assert.equal(e.ok, true, `peau à ${lumPeau}`);
  }
  // visage réellement bouché (beaucoup de noir pur) : signalé
  assert.equal(controles({ nbVisages: 1, r, c, lumPeau: 0.3, bouche: 0.2 }).find(x => x.id === 'exposition').ok, false);
});

test("lacet insensible à l'inclinaison de la tête", () => {
  for (const roulisDeg of [-8, 0, 8]) {
    const { lm, W, H } = visage({ roulisDeg });
    assert.ok(Math.abs(lacet(reperes(lm, W, H)) - 0.5) < 1e-9, `roulis ${roulisDeg}`);
  }
});

test('sommet du crâne borné par le haut réel de la tête (crâne rasé)', () => {
  const { lm, W, H } = visage({ d: 300 });
  const r = reperes(lm, W, H);
  assert.equal(borneCrane(r, 400), false);         // cheveux au-dessus de l'estimation : inchangé
  assert.equal(r.yeuxCrane, 300);
  assert.equal(borneCrane(r, 260), true);          // haut de tête plus bas que l'estimation
  assert.equal(r.hauteurTete, 560);
  const m = mesures(r, cadre(r));
  close(m.visageMm, NORME.visageCibleMm, 1e-9);
  close(m.craneMm, NORME.crane_haut_mm, 1e-9);
  assert.equal(borneCrane(r, null), false);
});
