// Règles des photos d'identité françaises (carte nationale d'identité, passeport) et calculs
// associés. Fonctions pures, testées sous Node.
//
// Sources (consultées le 14/11/2026) :
//  - service-public.gouv.fr, fiche F10619 « Quelle photo fournir pour un titre d'identité ? »
//    (vérifiée le 08/10/2026)
//  - Ministère de l'Intérieur, affiche « Nouvelle norme relative à l'apposition des photographies
//    d'identité… » (norme ISO/IEC 19794-5:2005), diffusée par les mairies
//
// Ce qui est vérifiable par logiciel est contrôlé ici ; le reste (lunettes, couvre-chef, frange,
// ressemblance, ancienneté) fait l'objet d'une liste à cocher par l'utilisateur.

export const NORME = {
  largeurMm: 35,
  hauteurMm: 45,
  // « du bas du menton au sommet du crâne (hors cheveux) » : 32 à 36 mm (70 à 80 % de la photo)
  visageMinMm: 32,
  visageMaxMm: 36,
  visageCibleMm: 34,   // milieu de la plage 32–36 : marge maximale face à l’incertitude sur le sommet du crâne
  craneSurMenton: 0.85, // yeux → sommet du crâne = 0,85 × yeux → menton (mesuré sur crânes dégagés : 0,78–0,89)
  // Le sommet du crâne est placé à 4 mm du bord haut : laisse un peu de place aux cheveux et met les
  // yeux dans la « zone des yeux » de la norme ISO/IEC 19794-5 (50 à 70 % de la hauteur depuis le bas).
  crane_haut_mm: 4,    // sommet du crâne à 4 mm du haut : place pour les cheveux, yeux vers 56 % depuis le bas
  yeuxBasMin: 0.50,   // zone des yeux (ISO/IEC 19794-5)
  yeuxBasMax: 0.70,
  // Résolutions d'impression
  dpiPhoto: 600,
  dpiPlanche: 300,
};

export const mmToPx = (mm, dpi) => (mm / 25.4) * dpi;

/** Taille en pixels de la photo 35×45 à une résolution donnée. */
export function taillePhoto(dpi = NORME.dpiPhoto) {
  return [Math.round(mmToPx(NORME.largeurMm, dpi)), Math.round(mmToPx(NORME.hauteurMm, dpi))];
}

// Indices des points MediaPipe Face Landmarker (478 points, iris inclus).
export const LM = {
  irisD: 468, irisG: 473,          // centres des iris (D = droite du sujet = gauche de l'image)
  oeilDext: 33, oeilDint: 133, oeilGint: 362, oeilGext: 263,
  menton: 152, front: 10, nez: 1,
  joueD: 234, joueG: 454,          // bords du visage
  pommetteD: 50, pommetteG: 280,   // zones de mesure d'éclairage
};

/**
 * Repères du visage en pixels de l'image source.
 * Le sommet du crâne n'est pas un point du maillage (il est sous les cheveux) : on l'estime par
 * l'anthropométrie, la ligne des yeux étant à mi-hauteur entre le menton et le sommet du crâne
 * (vertex–endocanthion ≈ endocanthion–menton chez l'adulte).
 */
export function reperes(lm, W, H) {
  const p = i => ({ x: lm[i].x * W, y: lm[i].y * H });
  const iD = p(LM.irisD), iG = p(LM.irisG), menton = p(LM.menton), nez = p(LM.nez);
  const yeux = { x: (iD.x + iG.x) / 2, y: (iD.y + iG.y) / 2 };
  // Inclinaison (roulis) : angle de la ligne des yeux, en degrés, positif = sens horaire à l'écran
  const roulis = Math.atan2(iG.y - iD.y, iG.x - iD.x) * 180 / Math.PI;
  // Distance yeux → menton mesurée perpendiculairement à la ligne des yeux (insensible au roulis)
  const ux = Math.cos(roulis * Math.PI / 180), uy = Math.sin(roulis * Math.PI / 180);
  const yeuxMenton = Math.abs((menton.x - yeux.x) * -uy + (menton.y - yeux.y) * ux);
  return {
    yeux, menton, nez, iD, iG, roulis, yeuxMenton,
    yeuxCrane: NORME.craneSurMenton * yeuxMenton,   // estimation ; voir sommetCrane()
    get hauteurTete() { return this.yeuxMenton + this.yeuxCrane; },  // menton → sommet du crâne, hors cheveux
    joueD: p(LM.joueD), joueG: p(LM.joueG),
    pommetteD: p(LM.pommetteD), pommetteG: p(LM.pommetteG),
  };
}

/**
 * Le sommet du crâne ne peut pas être au-dessus du haut de la tête détourée (chevelure comprise) :
 * pour une tête rasée ou des cheveux très courts, l'estimation anthropométrique est ramenée au
 * haut réel. `yeuxHaut` = distance yeux → haut du détourage (repère redressé), ou null.
 * Renvoie true si l'estimation a été corrigée.
 */
export function borneCrane(r, yeuxHaut) {
  if (yeuxHaut == null || !(yeuxHaut > 0)) return false;
  if (yeuxHaut < r.yeuxCrane) { r.yeuxCrane = yeuxHaut; return true; }
  return false;
}

/**
 * Sommet du crâne à partir du haut réel de la tête détourée (`yeuxHaut`, px depuis les yeux) et de
 * la probabilité « cheveux » des pixels du haut de la tête (`cheveuxHaut`, 0..1, null si inconnue).
 *  - haut de tête sans cheveux (crâne rasé ou chauve) : le sommet est MESURÉ → 'mesure' ;
 *  - sinon l'estimation anthropométrique est gardée, bornée par le haut de la tête → 'borne' | 'estime'.
 * Met à jour r.yeuxCrane et r.crane.
 */
export function sommetCrane(r, yeuxHaut, cheveuxHaut, peauHaut = true) {
  // plausible : crânes dégagés mesurés à 0,78–0,89 × yeux→menton ; borne haute sous la marge de la zone détourée
  const plausible = yeuxHaut > 0 && yeuxHaut > 0.7 * r.yeuxMenton && yeuxHaut < 1.2 * r.yeuxMenton;
  // peauHaut : le haut de la tête a la couleur du front (sinon bonnet, foulard… : pas de mesure)
  if (plausible && peauHaut && cheveuxHaut != null && cheveuxHaut < SEUILS.crane_degage) { r.yeuxCrane = yeuxHaut; r.crane = 'mesure'; }
  else r.crane = borneCrane(r, yeuxHaut) ? 'borne' : 'estime';
  return r.crane;
}

/**
 * Cadre 35×45 dans l'image source, après redressement du roulis.
 * Renvoie le centre de rotation, l'angle à appliquer et le rectangle (dans le repère redressé).
 * `reglages` : { zoom, dx, dy } retouches manuelles (dx, dy en mm sur la photo finale).
 */
export function cadre(r, reglages = {}) {
  const { zoom = 1, dx = 0, dy = 0, visageMm = NORME.visageCibleMm } = reglages;
  const pxParMm = r.hauteurTete / visageMm * zoom;   // pixels source par mm de photo
  const w = NORME.largeurMm * pxParMm, h = NORME.hauteurMm * pxParMm;
  // Dans le repère redressé (rotation de -roulis autour des yeux), le sommet du crâne est
  // à yeux.y - yeuxMenton.
  const craneY = r.yeux.y - r.yeuxCrane;
  const y = craneY - NORME.crane_haut_mm * pxParMm - dy * pxParMm;
  const x = r.yeux.x - w / 2 - dx * pxParMm;
  return { cx: r.yeux.x, cy: r.yeux.y, angle: -r.roulis, x, y, w, h, pxParMm };
}

/** Mesures sur la photo finale (en mm), à partir du cadre. */
export function mesures(r, c) {
  const visageMm = r.hauteurTete / c.pxParMm;
  const yeuxDepuisHaut = (r.yeux.y - c.y) / c.pxParMm;   // repère redressé : yeux.y inchangé
  const yeuxDepuisBas = NORME.hauteurMm - yeuxDepuisHaut;
  const mentonMm = yeuxDepuisHaut + r.yeuxMenton / c.pxParMm;
  const craneMm = yeuxDepuisHaut - r.yeuxCrane / c.pxParMm;
  const centreX = (r.yeux.x - c.x) / c.pxParMm;
  return { visageMm, yeuxDepuisHaut, yeuxRatioBas: yeuxDepuisBas / NORME.hauteurMm, mentonMm, craneMm, centreX };
}

/** Résolution source suffisante ? (pixels source par mm de photo, comparé au besoin d'impression) */
export function resolution(c, dpi = NORME.dpiPhoto) {
  const besoin = dpi / 25.4;
  return { pxParMm: c.pxParMm, besoin, ratio: c.pxParMm / besoin };
}

/**
 * Zones de peau dans le repère redressé (centre = milieu des yeux), en unités de l'image source :
 * le front et le haut des joues, à l'écart de la barbe, de la moustache et des sourcils.
 * e = écart entre les iris, ym = distance yeux → menton.
 */
export function zonesPeau(r) {
  const e = Math.hypot(r.iG.x - r.iD.x, r.iG.y - r.iD.y), ym = r.yeuxMenton, x = r.yeux.x, y = r.yeux.y;
  return {
    front: [x - 0.35 * e, y - 0.62 * ym, x + 0.35 * e, y - 0.38 * ym],
    joueD: [x - 0.78 * e, y + 0.14 * ym, x - 0.42 * e, y + 0.38 * ym],
    joueG: [x + 0.42 * e, y + 0.14 * ym, x + 0.78 * e, y + 0.38 * ym],
  };
}

/** Orientation de la tête (lacet) : position du nez entre les deux bords du visage, 0,5 = face. */
export function lacet(r) {
  const a = r.roulis * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a);
  const proj = p => p.x * ux + p.y * uy;   // coordonnée le long de la ligne des yeux
  return (proj(r.nez) - proj(r.joueD)) / Math.max(1, proj(r.joueG) - proj(r.joueD));
}

// Seuils des contrôles automatiques (valeurs de prudence : une photo de cabine agréée passe
// largement ; au-delà, l'agent d'accueil peut refuser).
export const SEUILS = {
  crane_degage: 0.25,     // probabilité « cheveux » moyenne en haut de la tête sous laquelle le crâne est dégagé
  roulisMax: 8,             // au-delà : redressée quand même, mais signalée (info)
  roulisKo: 15,             // au-delà : KO (redressement trop fort : épaules et cou de travers)
  lacetEcart: 0.06,         // |t - 0,5| ≈ 7° de rotation
  yeuxFermes: 0.45,         // blendshape eyeBlink
  boucheOuverte: 0.12,      // blendshape jawOpen
  sourire: 0.35,            // blendshape mouthSmile
  lumMin: 0.18, lumMax: 0.85,   // luminance perçue de la peau : plage large, valable pour toutes les carnations
  ecretageMax: 0.04,        // part maximale de peau brûlée (≥ 0,98) ou bouchée (≤ 0,03)
  asymetrieInfo: 1.25,      // rapport de luminance entre les deux joues : au-delà, avertissement
  asymetrieMax: 1.50,       // au-delà, ombre nette sur une moitié du visage (mesure par zones, approximative)
  netteteMin: 4,            // netteté normalisée (retouche.js) : en dessous, floue (KO)
  netteteInfo: 8,           // entre les deux : limite, à vérifier
  fondLumMin: 0.70, fondLumMax: 0.93, // clair mais pas blanc
};

/** Couleurs de fond proposées : claires, unies, jamais blanches. */
export const FONDS = {
  'gris-clair': { nom: 'Gris clair', hex: '#DADDE0' },
  'bleu-clair': { nom: 'Bleu clair', hex: '#CFE0EE' },
  'gris-perle': { nom: 'Gris perle', hex: '#C9CDD2' },
};

export function luminance(r, g, b) {
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
/** Luminance relative perçue (0..1) d'une couleur hexadécimale, pour vérifier « clair mais pas blanc ». */
export function fondConforme(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const L = luminance(r, g, b) ** (1 / 2.2); // ramené à une échelle perceptive
  const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  return { L, sat, ok: L >= SEUILS.fondLumMin && L <= SEUILS.fondLumMax && sat < 0.25 };
}

/**
 * Contrôles automatiques. `m` regroupe les mesures : r (repères), c (cadre), blend (blendshapes),
 * nbVisages, lumPeau, asym, nettete. Renvoie une liste { id, ok: true|false|null, texte, detail }.
 * ok = null : information seulement (non bloquant).
 */
export function controles(m) {
  const out = [];
  const add = (id, ok, texte, detail = '') => out.push({ id, ok, texte, detail });
  add('visage-unique', m.nbVisages === 1, 'Un seul visage sur la photo', m.nbVisages === 1 ? '' : `${m.nbVisages} visage(s) détecté(s)`);
  if (m.nbVisages !== 1) return out;
  const me = mesures(m.r, m.c);
  // Le cadrage met le visage à la taille réglée : ce n'est pas une mesure indépendante, car le
  // sommet du crâne (sous les cheveux) est estimé. Hors plage → KO ; dans la plage → information
  // seulement (à vérifier sur l'aperçu), jamais un « vert ».
  // Crâne dégagé (rasé, chauve) : sommet mesuré sur le détourage → vrai contrôle.
  const dansPlage = me.visageMm >= NORME.visageMinMm && me.visageMm <= NORME.visageMaxMm;
  if (m.r.crane === 'mesure') add('taille-visage', dansPlage, 'Visage de 32 à 36 mm (menton → sommet du crâne)',
    `${me.visageMm.toFixed(1)} mm (crâne dégagé : sommet mesuré)`);
  else add('taille-visage', dansPlage ? null : false, 'Visage de 32 à 36 mm (menton → sommet du crâne)',
    `réglé à ${me.visageMm.toFixed(1)} mm ; sommet du crâne estimé sous les cheveux${m.r.crane === 'borne' ? ' (borné par le haut de la tête)' : ''} : vérifie sur l'aperçu que le trait du haut passe au sommet du crâne`);
  if (m.hautCoupe != null) add('tete-entiere', !m.hautCoupe, 'Tête entière sur la photo d\u2019origine',
    m.hautCoupe ? 'le haut de la tête touche le bord de la photo d\u2019origine : reprends la photo avec de l\u2019espace au-dessus' : '');
  if (m.cheveuxCoupes != null) add('cheveux', m.cheveuxCoupes ? null : true, 'Haut de la tête dans la photo',
    m.cheveuxCoupes ? 'les cheveux touchent le bord haut : réduis un peu la taille du visage si possible' : '');
  if (m.basVide != null) add('buste', !m.basVide, 'Épaules jusqu\u2019en bas de la photo',
    m.basVide ? 'la photo source est trop serrée : la tête paraît flotter, recule ou cadre plus large' : '');
  add('zone-yeux', me.yeuxRatioBas >= NORME.yeuxBasMin && me.yeuxRatioBas <= NORME.yeuxBasMax,
    'Yeux dans la zone de la norme', `${Math.round(me.yeuxRatioBas * 100)} % de la hauteur depuis le bas`);
  add('centrage', Math.abs(me.centreX - NORME.largeurMm / 2) <= 1.5, 'Visage centré', `${(me.centreX - NORME.largeurMm / 2).toFixed(1)} mm`);
  add('menton', me.mentonMm <= NORME.hauteurMm - 1, 'Menton entièrement visible', `${me.mentonMm.toFixed(1)} mm du haut`);
  add('tete-droite', Math.abs(m.r.roulis) <= SEUILS.roulisMax ? true : Math.abs(m.r.roulis) <= SEUILS.roulisKo ? null : false, 'Tête droite',
    Math.abs(m.r.roulis) > 0.5 ? `inclinaison de ${Math.abs(m.r.roulis).toFixed(1)}° corrigée automatiquement` : '');
  const t = lacet(m.r);
  add('face', Math.abs(t - 0.5) <= SEUILS.lacetEcart, 'Visage de face', Math.abs(t - 0.5) > SEUILS.lacetEcart ? 'tête tournée sur le côté' : '');
  if (m.blend) {
    const b = m.blend;
    const blink = Math.max(b.eyeBlinkLeft ?? 0, b.eyeBlinkRight ?? 0);
    add('yeux-ouverts', blink < SEUILS.yeuxFermes, 'Yeux ouverts', blink >= SEUILS.yeuxFermes ? 'yeux fermés ou plissés' : '');
    add('bouche-fermee', (b.jawOpen ?? 0) < SEUILS.boucheOuverte, 'Bouche fermée', (b.jawOpen ?? 0) >= SEUILS.boucheOuverte ? 'bouche ouverte' : '');
    const smile = Math.max(b.mouthSmileLeft ?? 0, b.mouthSmileRight ?? 0);
    add('neutre', smile < SEUILS.sourire, 'Expression neutre (sans sourire)', smile >= SEUILS.sourire ? 'sourire détecté' : '');
  }
  if (m.lumPeau != null) {
    // On juge l'exposition à l'écrêtage (détails perdus), pas à la clarté de la peau, qui dépend
    // de la carnation : une peau foncée bien exposée est sombre et doit le rester.
    const hi = m.brule ?? 0, lo = m.bouche ?? 0;
    const trop = m.lumPeau > SEUILS.lumMax || hi > SEUILS.ecretageMax, peu = m.lumPeau < SEUILS.lumMin || lo > SEUILS.ecretageMax;
    add('exposition', !trop && !peu, 'Ni surexposée, ni sous-exposée',
      trop ? 'zones brûlées sur le visage : baisse la luminosité ou refais la photo' : peu ? 'visage bouché (trop sombre) : augmente la luminosité' : '');
  }
  if (m.asym != null) {
    const pct = Math.round((m.asym - 1) * 100);
    add('ombre', m.asym <= SEUILS.asymetrieInfo ? true : m.asym <= SEUILS.asymetrieMax ? null : false, "Pas d'ombre sur le visage",
      m.asym <= SEUILS.asymetrieInfo ? '' : m.asym <= SEUILS.asymetrieMax ? `une joue est environ ${pct} % plus sombre : vérifie à l'œil, éclaire de face si besoin` : `une moitié du visage est ${pct} % plus sombre : refais la photo face à la lumière`);
  }
  if (m.nettete != null) add('nettete', m.nettete >= SEUILS.netteteInfo ? true : m.nettete >= SEUILS.netteteMin ? null : false, 'Photo nette',
    m.nettete >= SEUILS.netteteInfo ? '' : m.nettete >= SEUILS.netteteMin ? 'netteté limite : vérifie que les yeux sont nets' : 'photo floue ou bougée');
  if (m.fond) add('fond', fondConforme(m.fond).ok, 'Fond uni, clair, non blanc (couleur choisie)', '');
  if (m.c) {
    const res = resolution(m.c);
    // 300 dpi utiles : tirage net ; 200 à 300 : correct ; en dessous : visible à l'impression
    const dpi = Math.round(res.ratio * NORME.dpiPhoto);
    add('resolution', dpi >= 300 ? true : dpi >= 200 ? null : false, "Résolution suffisante pour l'impression",
      dpi >= 300 ? `${dpi} dpi utiles` : dpi >= 200 ? `${dpi} dpi utiles : correct, 300 recommandés` : `${dpi} dpi utiles : photo trop petite, rapproche-toi ou utilise une meilleure photo`);
  }
  return out;
}

/** Liste à cocher : règles non vérifiables automatiquement. */
export const A_COCHER = [
  { id: 'nue', texte: 'Tête nue (ni chapeau, ni foulard, ni serre-tête)' },
  { id: 'degage', texte: 'Visage dégagé, oreilles dégagées, frange au-dessus des yeux' },
  { id: 'lunettes', texte: 'Sans lunettes, ou monture fine, verres non teintés et sans reflet' },
  { id: 'regard', texte: "Regard fixé sur l'objectif" },
  { id: 'recente', texte: 'Photo de moins de 6 mois, ressemblante' },
];
