import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NORME, SEUILS, LM, reperes, cadre, mesures, controles, taillePhoto, fondConforme, FONDS, resolution, lacet, borneCrane, sommetCrane, avecCrane, gabaritOvale } from '../js/norme.js';

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

test('repères : roulis, hauteur de tête = (1 + craneSurMenton) × (yeux → menton)', () => {
  const { lm, W, H } = visage({ d: 300, roulisDeg: 5 });
  const r = reperes(lm, W, H);
  close(r.roulis, 5, 1e-6);
  close(r.yeuxMenton, 300, 1e-6);
  close(r.hauteurTete, 300 * (1 + NORME.craneSurMenton), 1e-6);
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
  const { lm, W, H } = visage({ d: 60, roulisDeg: 20, nezDx: 40 });  // visage minuscule : < 200 dpi utiles
  const r = reperes(lm, W, H), c = cadre(r, { zoom: 1.2 });
  const res = controles({ nbVisages: 1, r, c, blend: { eyeBlinkLeft: .8, jawOpen: .3, mouthSmileLeft: .6 }, lumPeau: .5, brule: .2, asym: 1.6, nettete: 2, fond: '#FFFFFF' });
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
  close(resolution(c, 600).ratio, (r.hauteurTete / NORME.visageCibleMm) / (600 / 25.4), 1e-9);
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
  assert.equal(r.yeuxCrane, 255);
  assert.equal(borneCrane(r, 240), true);          // haut de tête plus bas que l'estimation
  assert.equal(r.hauteurTete, 540);
  const m = mesures(r, cadre(r));
  close(m.visageMm, NORME.visageCibleMm, 1e-9);
  close(m.craneMm, NORME.crane_haut_mm, 1e-9);
  assert.equal(borneCrane(r, null), false);
});

test('taille du visage : jamais « vert » (sommet du crâne estimé), KO hors plage', () => {
  const { lm, W, H } = visage({ d: 700 });
  const r = reperes(lm, W, H);
  const t = c => controles({ nbVisages: 1, r, c }).find(x => x.id === 'taille-visage').ok;
  assert.equal(t(cadre(r)), null);
  assert.equal(t(cadre(r, { visageMm: 38 })), false);
  assert.equal(t(cadre(r, { visageMm: 30 })), false);
});

test('tête coupée en haut de la photo d’origine : signalée', () => {
  const { lm, W, H } = visage({ d: 700 });
  const r = reperes(lm, W, H), c = cadre(r);
  const ok = h => controles({ nbVisages: 1, r, c, hautCoupe: h }).find(x => x.id === 'tete-entiere')?.ok;
  assert.equal(ok(true), false);
  assert.equal(ok(false), true);
  assert.equal(ok(undefined), undefined);
});

test('sommet du crâne : mesuré si le haut de la tête est sans cheveux, estimé sinon', () => {
  const mk = () => { const { lm, W, H } = visage({ d: 300 }); return reperes(lm, W, H); };
  let r = mk();
  assert.equal(sommetCrane(r, 330, 0.05), 'mesure');      // crâne rasé : mesure, même au-dessus de l'estimation
  assert.equal(r.yeuxCrane, 330);
  const c = controles({ nbVisages: 1, r, c: cadre(r) }).find(x => x.id === 'taille-visage');
  assert.equal(c.ok, true);
  r = mk(); assert.equal(sommetCrane(r, 380, 0.9), 'estime');  // cheveux : estimation gardée
  assert.equal(r.yeuxCrane, 255);
  r = mk(); assert.equal(sommetCrane(r, 240, 0.9), 'borne');
  r = mk(); assert.equal(sommetCrane(r, 330, null), 'estime');  // segmentation indisponible
  r = mk(); assert.equal(sommetCrane(r, 270, 0.05, false), 'estime');  // bonnet ou foulard : pas de mesure
  r = mk(); assert.equal(sommetCrane(r, 600, 0.05), 'estime');  // mesure aberrante ignorée
  assert.equal(controles({ nbVisages: 1, r, c: cadre(r) }).find(x => x.id === 'taille-visage').ok, null);
});

test('sommet du crâne placé à la main : visage recalé', () => {
  const r = { yeux: { x: 500, y: 500 }, yeuxMenton: 200, yeuxCrane: 170, roulis: 0, get hauteurTete() { return this.yeuxMenton + this.yeuxCrane; } };
  assert.equal(avecCrane(r, 0), r);
  const m = avecCrane(r, 2, 34);
  assert.equal(m.crane, 'manuel');
  close(m.yeuxCrane, 170 + 2 * 370 / 32);
  close(m.hauteurTete, 200 + m.yeuxCrane);
  assert.equal(r.yeuxCrane, 170);                       // repères d'origine intacts
  // le cadre remet le visage à 34 mm : le sommet corrigé est à 4 mm du haut
  const c = cadre(m, { visageMm: 34 }), me = mesures(m, c);
  close(me.visageMm, 34); close(me.craneMm, NORME.crane_haut_mm);
  // crâne abaissé : jamais sous les yeux
  assert.ok(avecCrane(r, -50, 34).yeuxCrane >= 0.3 * 200);
});

test('ovale de contrôle : anneau 32–36 mm centré sur le cadrage automatique', () => {
  const { interieur: i, exterieur: e } = gabaritOvale();
  close(i.ry * 2, 32); close(e.ry * 2, 36);
  close(i.cx, 17.5); close(i.cy, e.cy);
  close(i.cy - i.ry, NORME.crane_haut_mm + 1);         // sommet de l'ovale intérieur à 5 mm du haut
  close(e.cy + e.ry, NORME.crane_haut_mm + 34 + 1);    // bas de l'ovale extérieur à 39 mm (menton auto à 38)
  assert.ok(e.cx + e.rx < NORME.largeurMm && e.cx - e.rx > 0);
});

test('sommet placé à la main : le trait se décale de la valeur affichée, contrôle jamais vert', () => {
  const r = { yeux: { x: 500, y: 500 }, nez: { x: 500, y: 600 }, joueD: { x: 380, y: 560 }, joueG: { x: 620, y: 560 }, yeuxMenton: 200, yeuxCrane: 170, roulis: 0, get hauteurTete() { return this.yeuxMenton + this.yeuxCrane; } };
  // l'ancien sommet estimé se retrouve exactement 2 mm sous le trait du haut, après recalage
  const m = avecCrane(r, 2, 34), c = cadre(m, { visageMm: 34 });
  close((r.yeux.y - r.yeuxCrane - c.y) / c.pxParMm, NORME.crane_haut_mm + 2);
  const base = { nbVisages: 1, c, r: m };
  const t = controles(base).find(x => x.id === 'taille-visage');
  assert.equal(t.ok, null);
  assert.match(t.detail, /à la main/);
});

test('ovale de contrôle centré sur le visage réglé', () => {
  for (const v of [32.5, 34, 35.5]) {
    const { interieur: i, exterieur: e } = gabaritOvale(v);
    // sommet (4 mm) et menton (4 + v) du cadrage tombent dans l'anneau
    assert.ok(e.cy - e.ry <= NORME.crane_haut_mm && NORME.crane_haut_mm <= i.cy - i.ry, `haut ${v}`);
    assert.ok(i.cy + i.ry <= NORME.crane_haut_mm + v && NORME.crane_haut_mm + v <= e.cy + e.ry, `bas ${v}`);
  }
});
