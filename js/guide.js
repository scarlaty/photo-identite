// Prise de vue guidée : à partir des repères du visage sur l'image de la caméra, dit ce qu'il faut
// corriger avant de déclencher. Fonction pure (testée), utilisée par camera.js à chaque image.

import { reperes, lacet, NORME } from './norme.js';

// Seuils un peu plus stricts que ceux de l'analyse (norme.js, SEUILS) pour garder une marge, sauf
// la lumière : la vidéo ne permet pas de juger les zones brûlées, donc la plage est large (peaux foncées).
export const GUIDE = {
  roulisMax: 4,           // ° : plus strict qu'à l'analyse, la photo sera redressée de toute façon
  lacetEcart: 0.045,
  // px : hauteur de tête (1 + craneSurMenton) × yeux→menton ≥ 34 mm à 300 dpi (≈ 402 px)
  yeuxMentonMin: Math.ceil(NORME.visageCibleMm / 25.4 * 300 / (1 + NORME.craneSurMenton)),
  margeHaut: 0.75,        // au-dessus des yeux : crâne (1 × yeux→menton) + cheveux et marge, en yeux→menton
  margeBas: 0.7,          // sous le menton : cou et épaules
  centrageMax: 0.12,      // décalage horizontal max des yeux, en largeur d'image
  clignement: 0.35, sourire: 0.3, bouche: 0.1,
  lumMin: 0.15, lumMax: 0.85, asymMax: 1.35,
};

/**
 * `v` : { nb, lm, blend, W, H, lum, asym } (lum, asym : mesurés sur la peau par l'appelant, ou null).
 * Renvoie { ok, message, items: [{ id, ok, texte }] } ; `message` = première chose à corriger.
 */
export function conseils(v) {
  const items = [];
  const add = (id, ok, texte) => items.push({ id, ok, texte });
  if (!v.nb) return fin([{ id: 'visage', ok: false, texte: 'Place ton visage dans l’ovale' }]);
  if (v.nb > 1) return fin([{ id: 'visage', ok: false, texte: 'Une seule personne devant l’objectif' }]);
  const r = reperes(v.lm, v.W, v.H), d = r.yeuxMenton;
  const haut = r.yeux.y - (1 + GUIDE.margeHaut) * d, bas = r.menton.y + GUIDE.margeBas * d;
  if (d < GUIDE.yeuxMentonMin) add('distance', false, 'Approche-toi (ou zoome)');
  else if (haut < 0 || bas > v.H) add('distance', false, haut < 0 && bas > v.H ? 'Recule un peu' : haut < 0 ? 'Baisse un peu l’appareil (place pour les cheveux)' : 'Monte un peu l’appareil (épaules visibles)');
  else add('distance', true, 'Distance');
  add('centre', Math.abs(r.yeux.x / v.W - 0.5) <= GUIDE.centrageMax, 'Centre ton visage');
  add('droite', Math.abs(r.roulis) <= GUIDE.roulisMax, 'Redresse la tête');
  add('face', Math.abs(lacet(r) - 0.5) <= GUIDE.lacetEcart, 'Regarde droit l’objectif');
  const b = v.blend || {};
  add('yeux', Math.max(b.eyeBlinkLeft ?? 0, b.eyeBlinkRight ?? 0) < GUIDE.clignement, 'Ouvre bien les yeux');
  add('neutre', Math.max(b.mouthSmileLeft ?? 0, b.mouthSmileRight ?? 0) < GUIDE.sourire && (b.jawOpen ?? 0) < GUIDE.bouche, 'Visage neutre, bouche fermée');
  if (v.lum != null) add('lumiere', v.lum >= GUIDE.lumMin && v.lum <= GUIDE.lumMax, v.lum < GUIDE.lumMin ? 'Plus de lumière (face à une fenêtre)' : 'Trop de lumière');
  if (v.asym != null) add('ombre', v.asym <= GUIDE.asymMax, 'Éclairage inégal : mets-toi face à la lumière');
  return fin(items, r);
}

function fin(items, r = null) {
  const ko = items.find(x => !x.ok);
  return { ok: !ko, message: ko ? ko.texte : 'Parfait, ne bouge plus', items, r };
}

