// Post-traitement du masque de détourage. Fonctions pures (aucun accès au DOM),
// testées sous Node avec `node --test`.
//
// Conventions : une image RGBA est un Uint8ClampedArray de w*h*4 octets, un masque
// est un Float32Array de w*h valeurs dans [0, 1].

/** Flou boîte séparable (somme glissante), O(w*h) quel que soit le rayon. Bords répliqués. */
export function boxBlur(src, w, h, r) {
  r = Math.max(1, Math.round(r));
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      acc += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
    }
  }
  return out;
}

/** Agrandit/réduit un masque (interpolation bilinéaire). */
export function resizeMask(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const kx = sw / dw, ky = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, (y + 0.5) * ky - 0.5), y0 = Math.min(sh - 1, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, (x + 0.5) * kx - 0.5), x0 = Math.min(sw - 1, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/** Teinte en degrés [0, 360) d'un pixel RGB 0..255. */
export function hue(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
  if (c === 0) return 0;
  let h;
  if (mx === r) h = ((g - b) / c) % 6;
  else if (mx === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error('couleur invalide : ' + hex);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Probabilité [0,1] qu'un pixel appartienne à la couleur du fond à retirer (ex. filet bleu).
 * On compare la teinte, et on exige une chrominance absolue (max-min) suffisante :
 * la saturation HSV, elle, explose dans les noirs et ferait des trous dans un maillot sombre.
 */
export function keyMap(rgba, w, h, keyHex, tolerance = 40) {
  const [kr, kg, kb] = hexToRgb(keyHex), kh = hue(kr, kg, kb);
  const out = new Float32Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    if (chroma < 0.08) continue;
    let dh = Math.abs(hue(r, g, b) - kh); if (dh > 180) dh = 360 - dh;
    out[p] = clamp01(1 - dh / tolerance) * clamp01((chroma - 0.08) / 0.12);
  }
  return dilate3(out, w, h);
}

/** Maximum sur un voisinage 3x3 : attrape les pixels mélangés au bord des mailles. */
export function dilate3(src, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= w) continue;
        const v = src[yy * w + xx]; if (v > m) m = v;
      }
    }
    out[y * w + x] = m;
  }
  return out;
}

/** Bande de contour : pixels à moins de ~r px de la frontière sujet/fond. */
export function contourBand(mask, w, h, r) {
  const bin = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) bin[p] = mask[p] > 0.5 ? 1 : 0;
  const b = boxBlur(bin, w, h, r);
  const band = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) band[p] = b[p] > 0.01 && b[p] < 0.99 ? 1 : 0;
  const grown = boxBlur(band, w, h, Math.max(1, r / 7));
  const out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) out[p] = grown[p] > 0 ? 1 : 0;
  return out;
}

/** Supprime les îlots (composantes 4-connexes) plus petits que `ratio` × la plus grande. */
export function removeIslands(mask, w, h, ratio = 0.02) {
  const N = w * h, lab = new Int32Array(N), stack = new Int32Array(N), sizes = [0];
  let n = 0;
  for (let p = 0; p < N; p++) {
    if (lab[p] || mask[p] <= 0.5) continue;
    n++; let sp = 0, cnt = 0; stack[sp++] = p; lab[p] = n;
    while (sp) {
      const q = stack[--sp]; cnt++; const x = q % w;
      if (x > 0 && !lab[q - 1] && mask[q - 1] > 0.5) { lab[q - 1] = n; stack[sp++] = q - 1; }
      if (x < w - 1 && !lab[q + 1] && mask[q + 1] > 0.5) { lab[q + 1] = n; stack[sp++] = q + 1; }
      if (q >= w && !lab[q - w] && mask[q - w] > 0.5) { lab[q - w] = n; stack[sp++] = q - w; }
      if (q < N - w && !lab[q + w] && mask[q + w] > 0.5) { lab[q + w] = n; stack[sp++] = q + w; }
    }
    sizes.push(cnt);
  }
  if (n < 2) return mask;
  let big = 0; for (let i = 1; i <= n; i++) if (sizes[i] > big) big = sizes[i];
  const keep = big * ratio;
  // Les pixels semi-transparents rattachés à un îlot supprimé disparaissent aussi :
  // on efface tout ce qui, autour d'un îlot supprimé, n'appartient à aucune composante gardée.
  const rm = new Uint8Array(N);
  for (let p = 0; p < N; p++) if (lab[p] && sizes[lab[p]] < keep) rm[p] = 1;
  const near = boxBlur(Float32Array.from(rm), w, h, 2);
  const out = new Float32Array(mask);
  for (let p = 0; p < N; p++) {
    if (rm[p]) out[p] = 0;
    else if (!lab[p] && near[p] > 0) out[p] = 0;
  }
  return out;
}

/** Contraste du masque : 0 = masque du modèle tel quel, 100 = bords très durs. */
export function sharpen(mask, amount) {
  if (!amount) return mask;
  const lo = amount * 0.004, hi = 1 - amount * 0.003, span = Math.max(1e-3, hi - lo);
  const out = new Float32Array(mask.length);
  for (let p = 0; p < mask.length; p++) out[p] = clamp01((mask[p] - lo) / span);
  return out;
}

/**
 * Estimation de la couleur de premier plan (Forte & Pitié 2021, « blur-fusion »).
 * Retire des pixels de bord la couleur du fond d'origine (bleu du filet, bois...),
 * sans quoi un halo apparaît sur le nouveau fond.
 */
export function estimateForeground(rgba, mask, w, h, scale = 1) {
  const N = w * h;
  const I = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  for (let p = 0, i = 0; p < N; p++, i += 4) { I[0][p] = rgba[i] / 255; I[1][p] = rgba[i + 1] / 255; I[2][p] = rgba[i + 2] / 255; }
  let F, B1;
  { const [F1, b1] = blurFusion(I, I, I, mask, w, h, Math.max(3, 45 * scale)); B1 = b1; [F] = blurFusion(I, F1, B1, mask, w, h, Math.max(1, 3 * scale)); }
  // Bande du contour (mèches) : là seulement on retire la teinte de l'ancien fond
  const band = contourBand(mask, w, h, Math.max(4, 12 * scale));
  // Couleur locale du sujet : pixels opaques HORS bande (sans reflet), voisins proches. Un maillot
  // bleu au bord a pour voisins du maillot bleu : il n'est pas tiré vers une autre couleur.
  const sub = subjectColor(I, mask, band, w, h, Math.max(6, 45 * scale), Math.max(1, Math.round(2 * scale)));
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const out = new Uint8ClampedArray(N * 4);
  for (let p = 0, i = 0; p < N; p++, i += 4) {
    const a = mask[p];
    // Opaque : pixels d'origine (aucune perte de détail ; seule la bande du contour passe ensuite par
    // le retrait de teinte) ; bord semi-transparent : estimation blur-fusion
    let r, g, b;
    if (a > 0.98) { r = I[0][p]; g = I[1][p]; b = I[2][p]; } else { r = F[0][p]; g = F[1][p]; b = F[2][p]; }
    const sc = (band[p] || a <= 0.98) && a > 0.01 ? sub(p) : null;
    if (sc) {
      // « Despill » : chromaticité du pixel (couleur / luminance) ramenée vers celle du sujet, mais
      // seulement de la part qui va vers la couleur du fond d'origine (reflet bleu sur des cheveux
      // roux) ; une couleur propre au sujet (maillot bleu) n'est pas tirée vers le fond, donc gardée.
      const y = lum(r, g, b);
      const [cr, cg, cb] = sc, yc = lum(cr, cg, cb);
      const br = B1[0][p], bg = B1[1][p], bb = B1[2][p], yb = lum(br, bg, bb);
      if (y > 1e-3 && yc > 1e-3 && yb > 1e-3) {
        const pr = r / y, pg = g / y, pb = b / y;           // chromaticités
        const sr = cr / yc, sg = cg / yc, sb = cb / yc;
        const dr = br / yb - sr, dg = bg / yb - sg, db = bb / yb - sb;   // direction sujet → fond
        const n2 = dr * dr + dg * dg + db * db;
        if (n2 > 1e-4) {
          const k = Math.max(0, Math.min(1, ((pr - sr) * dr + (pg - sg) * dg + (pb - sb) * db) / n2));
          r = clamp01((pr - k * dr) * y); g = clamp01((pg - k * dg) * y); b = clamp01((pb - k * db) * y);
        }
      }
    }
    out[i] = 255 * r; out[i + 1] = 255 * g; out[i + 2] = 255 * b; out[i + 3] = 255 * a;
  }
  return out;
}

/**
 * Couleur moyenne des pixels opaques hors bande autour de chaque pixel, calculée sur une grille
 * réduite d'un facteur q (mémoire et temps ÷ q²). Renvoie p → [r, g, b] ou null (aucun voisin).
 */
function subjectColor(I, mask, band, w, h, r, q) {
  const gw = Math.ceil(w / q), gh = Math.ceil(h / q), G = gw * gh;
  const op = new Float32Array(G), acc = [new Float32Array(G), new Float32Array(G), new Float32Array(G)];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (mask[p] <= 0.95 || band[p]) continue;
    const g = ((y / q) | 0) * gw + ((x / q) | 0);
    op[g]++; acc[0][g] += I[0][p]; acc[1][g] += I[1][p]; acc[2][g] += I[2][p];
  }
  const rr = Math.max(1, r / q), bop = boxBlur(op, gw, gh, rr), C = acc.map(c => boxBlur(c, gw, gh, rr));
  return p => {
    const g = (((p / w) | 0) / q | 0) * gw + (((p % w) / q) | 0);
    const n = bop[g];
    return n > 0.02 * q * q ? [C[0][g] / n, C[1][g] / n, C[2][g] / n] : null;   // ≥ 2 % de voisins opaques, sinon rien
  };
}

function blurFusion(I, F, B, a, w, h, r) {
  const N = w * h, inv = new Float32Array(N);
  for (let p = 0; p < N; p++) inv[p] = 1 - a[p];
  const ba = boxBlur(a, w, h, r), bi = boxBlur(inv, w, h, r);
  const Fn = [], Bn = [];
  for (let c = 0; c < 3; c++) {
    const fa = new Float32Array(N), bb = new Float32Array(N);
    for (let p = 0; p < N; p++) { fa[p] = F[c][p] * a[p]; bb[p] = B[c][p] * inv[p]; }
    const bfa = boxBlur(fa, w, h, r), bbb = boxBlur(bb, w, h, r);
    const f = new Float32Array(N), b = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const fb = bfa[p] / (ba[p] + 1e-5), bk = bbb[p] / (bi[p] + 1e-5), al = a[p];
      f[p] = clamp01(fb + al * (I[c][p] - al * fb - (1 - al) * bk));
      b[p] = bk;
    }
    Fn.push(f); Bn.push(b);
  }
  return [Fn, Bn];
}

/**
 * Chaîne complète : masque brut du modèle (taille mw*mh) + pixels de la zone (w*h)
 * → RGBA détouré (w*h*4).
 */
export function refine(rgba, w, h, rawMask, mw, mh, opts = {}) {
  const { keyColor = null, keyTolerance = 40, sharpness = 0 } = opts;
  const scale = Math.max(w, h) / 1024;
  let m = resizeMask(rawMask, mw, mh, w, h);
  if (keyColor) {
    const key = keyMap(rgba, w, h, keyColor, keyTolerance);
    const band = contourBand(m, w, h, Math.max(4, 14 * scale));
    for (let p = 0; p < w * h; p++) if (band[p]) m[p] *= 1 - key[p];
  }
  m = removeIslands(m, w, h);
  m = sharpen(m, sharpness);
  return estimateForeground(rgba, m, w, h, scale);
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
