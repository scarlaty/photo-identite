// Mise en page de la planche 10×15 (6 photos 35×45) et marquage de la résolution du JPEG.
// Fonctions pures, testées sous Node.
import { NORME, mmToPx } from './norme.js';

// Tirage « 10×15 » des laboratoires : 4×6 pouces = 101,6 × 152,4 mm (paysage).
export const PLANCHE = { largeurMm: 152.4, hauteurMm: 101.6 };

/**
 * Emplacements des 6 photos (3 colonnes × 2 rangées), espacement égal, en pixels.
 * mode 'identiques' : la même photo partout ; 'trio' : une colonne par personne (2 photos chacune).
 * Renvoie { W, H, photos: [{x, y, w, h, source}], traits: [[x1,y1,x2,y2]], echelle }.
 */
export function planche(dpi = NORME.dpiPlanche, mode = 'identiques') {
  const W = Math.round(mmToPx(PLANCHE.largeurMm, dpi)), H = Math.round(mmToPx(PLANCHE.hauteurMm, dpi));
  const pw = mmToPx(NORME.largeurMm, dpi), ph = mmToPx(NORME.hauteurMm, dpi);
  const cols = 3, rows = 2;
  const gx = (W - cols * pw) / (cols + 1), gy = (H - rows * ph) / (rows + 1);
  const photos = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    photos.push({ x: Math.round(gx + c * (pw + gx)), y: Math.round(gy + r * (ph + gy)), w: Math.round(pw), h: Math.round(ph),
      source: mode === 'trio' ? c : 0 });
  }
  // Repères de coupe : petits traits dans les marges, hors des photos (2 mm, à 0,8 mm du bord)
  const L = mmToPx(2, dpi), o = mmToPx(0.8, dpi), traits = [];
  for (const p of photos) {
    for (const [x, y, sx, sy] of [[p.x, p.y, -1, -1], [p.x + p.w, p.y, 1, -1], [p.x, p.y + p.h, -1, 1], [p.x + p.w, p.y + p.h, 1, 1]]) {
      traits.push([x + sx * o, y, x + sx * (o + L), y]);  // horizontal
      traits.push([x, y + sy * o, x, y + sy * (o + L)]);  // vertical
    }
  }
  // Barre d'échelle de 10 mm dans la marge de droite, pour vérifier que l'impression est à 100 %
  const ex = W - gx / 2, ey = H / 2 - mmToPx(5, dpi);
  return { W, H, photos, traits, echelle: { x: ex, y1: ey, y2: ey + mmToPx(10, dpi) }, margeX: gx, margeY: gy };
}

/**
 * Inscrit la résolution (points par pouce) dans l'en-tête JFIF d'un JPEG, pour que l'imprimante
 * ou le laboratoire reproduise la taille réelle. Les navigateurs écrivent 72 ou rien.
 * Prend et renvoie un Uint8Array.
 */
export function jpegDpi(bytes, dpi) {
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) throw new Error('pas un JPEG');
  // Segment APP0 JFIF juste après SOI ?
  if (bytes[2] === 0xFF && bytes[3] === 0xE0 && String.fromCharCode(...bytes.slice(6, 11)) === 'JFIF\0') {
    const out = new Uint8Array(bytes);
    out[13] = 1;                          // unités : points par pouce
    out[14] = dpi >> 8; out[15] = dpi & 255;   // densité X
    out[16] = dpi >> 8; out[17] = dpi & 255;   // densité Y
    return out;
  }
  // Sinon on insère un APP0 JFIF minimal
  const app0 = new Uint8Array([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01,
    dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0x00, 0x00]);
  const out = new Uint8Array(bytes.length + app0.length);
  out.set(bytes.slice(0, 2), 0); out.set(app0, 2); out.set(bytes.slice(2), 2 + app0.length);
  return out;
}

/** Lit la résolution JFIF (pour les tests et le contrôle avant export). */
export function lireJpegDpi(bytes) {
  if (bytes[2] === 0xFF && bytes[3] === 0xE0 && bytes[13] === 1) return (bytes[14] << 8) | bytes[15];
  return null;
}
