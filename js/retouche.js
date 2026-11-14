// Retouches autorisées (luminosité, contraste, couleurs) et mesures d'image. Fonctions pures.
// Aucune retouche ne modifie les traits du visage : seulement l'exposition et la couleur,
// appliquées au sujet détouré (le fond, lui, est une couleur unie choisie).

const lin = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gam = v => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const LUT_LIN = new Float32Array(256).map((_, i) => lin(i / 255));
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Luminance perçue (0..1) d'un pixel sRGB 0..255. */
export function lumPx(r, g, b) {
  return gam(0.2126 * LUT_LIN[r] + 0.7152 * LUT_LIN[g] + 0.0722 * LUT_LIN[b]);
}

/** Moyenne de luminance perçue sur un rectangle (pixels dont alpha > 0,5 seulement si alpha fourni). */
export function lumZone(rgba, w, h, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(w, Math.ceil(x1)); y1 = Math.min(h, Math.ceil(y1));
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * 4;
    if (rgba[i + 3] < 128) continue;
    s += lumPx(rgba[i], rgba[i + 1], rgba[i + 2]); n++;
  }
  return n ? s / n : null;
}

/** Part des pixels opaques d'un rectangle qui sont brûlés (≥ hi) ou bouchés (≤ lo). */
export function ecretage(rgba, w, h, x0, y0, x1, y1, lo = 0.03, hi = 0.98) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(w, Math.ceil(x1)); y1 = Math.min(h, Math.ceil(y1));
  let nb = 0, nh = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * 4;
    if (rgba[i + 3] < 128) continue;
    const l = lumPx(rgba[i], rgba[i + 1], rgba[i + 2]); n++;
    if (l <= lo) nb++; else if (l >= hi) nh++;
  }
  return n ? { bouche: nb / n, brule: nh / n } : null;
}

/**
 * Netteté : variance du laplacien rapportée à la variance des niveaux de gris (× 1000), sur la zone
 * du visage ramenée à une largeur fixe par l'appelant. Rapportée au contraste, la mesure ne pénalise
 * pas les peaux foncées ou les éclairages doux (photos nettes : 14 à 93 ; floutées σ = 1,5 : 1 à 6).
 */
export function nettete(gray, w, h) {
  let s = 0, s2 = 0, n = 0, g = 0, g2 = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
    s += l; s2 += l * l; n++; g += gray[i]; g2 += gray[i] * gray[i];
  }
  if (!n) return 0;
  const vl = s2 / n - (s / n) ** 2, vg = g2 / n - (g / n) ** 2;
  return vg > 1e-6 ? 1000 * vl / vg : 0;
}

/**
 * Applique les réglages au RGBA (en place). Réglages (0 = neutre) :
 *  exposition  -1..1  (±1 IL, en lumière linéaire)
 *  contraste   -1..1
 *  ombres       0..1  (débouche les zones sombres)
 *  saturation  -1..1
 *  temperature -1..1  (négatif = plus froid, positif = plus chaud)
 */
export function appliquer(rgba, opts) {
  const { exposition = 0, contraste = 0, ombres = 0, saturation = 0, temperature = 0 } = opts;
  if (!exposition && !contraste && !ombres && !saturation && !temperature) return rgba;
  const gain = 2 ** exposition;
  const gR = 1 + 0.08 * temperature, gB = 1 - 0.08 * temperature;
  const k = 1 + contraste * 0.6;
  // Table de correspondance sur la luminance perçue (exposition, ombres, contraste)
  const lut = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) {
    let v = gam(clamp01(lin(i / 1023) * gain));
    if (ombres) v = v + ombres * 0.35 * v * (1 - v) ** 2 * 4;      // relève surtout les tons bas
    v = (v - 0.5) * k + 0.5;
    lut[i] = clamp01(v);
  }
  const sat = 1 + saturation;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    let r = LUT_LIN[rgba[i]] * gR, g = LUT_LIN[rgba[i + 1]], b = LUT_LIN[rgba[i + 2]] * gB;
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (sat !== 1) { r = Y + (r - Y) * sat; g = Y + (g - Y) * sat; b = Y + (b - Y) * sat; }
    // la courbe agit sur la luminance ; la chrominance suit le même rapport
    const Yp = gam(clamp01(Y)), Yn = lut[Math.min(1023, Math.round(Yp * 1023))];
    const f = Yp > 1e-4 ? lin(Yn) / Math.max(1e-6, Y) : 1;
    rgba[i] = 255 * gam(clamp01(r * f));
    rgba[i + 1] = 255 * gam(clamp01(g * f));
    rgba[i + 2] = 255 * gam(clamp01(b * f));
  }
  return rgba;
}

/**
 * Exposition automatique. On ne corrige que ce qui sort de la plage acceptable [min, max] :
 * ramener toutes les peaux à une même valeur éclaircirait à tort les peaux mates ou foncées.
 */
export function expositionAuto(lumPeau, min = 0.2, max = 0.82) {
  if (!lumPeau) return 0;
  const cible = lumPeau < min ? min + 0.04 : lumPeau > max ? max - 0.04 : lumPeau;
  if (cible === lumPeau) return 0;
  // en lumière linéaire, le gain est le rapport des luminances linéaires
  const g = lin(cible) / Math.max(1e-4, lin(lumPeau));
  return Math.max(-0.8, Math.min(0.8, Math.log2(g)));
}

/** Équilibre des blancs automatique sur la peau : rapport R/B ramené à une valeur typique. */
export function temperatureAuto(rMoy, bMoy, cible = 1.35) {
  if (!rMoy || !bMoy) return 0;
  const ratio = rMoy / bMoy;  // peau : rouge > bleu ; trop haut = trop chaud
  const t = (cible / ratio - 1) / 0.16;
  return Math.max(-1, Math.min(1, t));
}
