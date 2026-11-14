import { RES } from './models.js';
import { analyserVisage, segmenterCheveux } from './face.js';
import { NORME, FONDS, A_COCHER, reperes, cadre, mesures, controles, taillePhoto, zonesPeau, sommetCrane } from './norme.js';
import { appliquer, lumZone, ecretage, nettete, expositionAuto } from './retouche.js';
import { planche, jpegDpi } from './planche.js';
import { cameraDisponible, ouvrirCamera } from './camera.js';

const $ = id => document.getElementById(id);
const MAX_SIDE = 4000;     // côté max de la photo source conservée
const MAX_REGION = 2400;   // côté max de la zone détourée (la photo 35×45 à 600 dpi fait 827×1063)
const ADJ0 = { visage: NORME.visageCibleMm, dx: 0, dy: 0, exposition: 0, contraste: 0, ombres: 0, temperature: 0, saturation: 0 };

/* ---------------- réglages globaux ---------------- */
const STORE = 'photo-identite:v1';
const G = { mode: 'identiques', fond: 'gris-clair' };
try { Object.assign(G, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch { /* stockage indisponible */ }
if (!['identiques', 'trio'].includes(G.mode)) G.mode = 'identiques';
if (!FONDS[G.fond]) G.fond = 'gris-clair';
const persist = () => { try { localStorage.setItem(STORE, JSON.stringify(G)); } catch { /* idem */ } };

/* ---------------- workers (détourage) ---------------- */
let inferW = null, matteW = null, reqId = 0, modelP = null, engineDown = null;
const pend = new Map();
function failAll(err) { for (const p of pend.values()) p.reject(err); pend.clear(); }
function getInfer() {
  if (engineDown) throw engineDown;
  if (!inferW) {
    inferW = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    inferW.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') { pend.get('load')?.kick?.(); if (!m.cached) { setStatus(`Téléchargement du modèle de détourage (une seule fois) : ${Math.round(m.loaded / 1e6)} / ${Math.round(m.total / 1e6)} Mo`); setBar(m.loaded / m.total); } }
      else if (m.type === 'status') setStatus(m.text);
      else if (m.type === 'ready') { $('backend').hidden = false; $('backend').textContent = m.backend === 'webgpu' ? 'Accélération : WebGPU' : 'Accélération : aucune (plus lent)'; setBar(null); pend.get('load')?.resolve(); pend.delete('load'); }
      else if (m.type === 'mask') { pend.get(m.id)?.resolve(m.mask); pend.delete(m.id); }
      else if (m.type === 'error') { const k = m.id ?? 'load'; pend.get(k)?.reject(new Error(m.message)); pend.delete(k); if (k === 'load') modelP = null; }
    };
    inferW.onerror = e => { e.preventDefault?.(); failAll(new Error("le moteur de détourage n'a pas pu démarrer (connexion ?)")); inferW?.terminate(); inferW = null; modelP = null; engineDown = new Error('moteur de détourage indisponible : vérifie la connexion puis recharge la page'); };
  }
  return inferW;
}
function getMatte() {
  if (!matteW) {
    matteW = new Worker(new URL('./matte-worker.js', import.meta.url), { type: 'module' });
    matteW.onmessage = e => { const p = pend.get(e.data.id); if (!p) return; pend.delete(e.data.id); e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.rgba); };
    matteW.onerror = e => { e.preventDefault?.(); failAll(new Error('le nettoyage des contours a planté')); matteW?.terminate(); matteW = null; };
  }
  return matteW;
}
function ensureModel() {
  if (modelP) return modelP;
  // Délai d'inactivité (relancé à chaque progression du téléchargement) : jamais d'attente infinie.
  modelP = new Promise((resolve, reject) => {
    let t = 0;
    const kick = () => { clearTimeout(t); t = setTimeout(() => { if (pend.get('load')?.kick === kick) { pend.delete('load'); modelP = null; reject(new Error('le modèle de détourage ne se charge pas (connexion ?) : réessaie')); } }, 180_000); };
    pend.set('load', { kick, resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
    kick();
    getInfer().postMessage({ type: 'load', model: 'ben2' });
  });
  modelP.catch(() => {});
  return modelP;
}
function request(worker, msg, transfer, timeout) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { if (pend.has(id)) { pend.delete(id); reject(new Error('délai dépassé')); } }, timeout);
    pend.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
    worker.postMessage({ ...msg, id }, transfer);
  });
}
const infer = px => request(getInfer(), { type: 'run', pixels: px }, [px.buffer], 900_000);
const matte = (px, w, h, mask) => request(getMatte(), { pixels: px, w, h, mask, opts: { keyColor: null, sharpness: 0 } }, [px.buffer], 180_000);

/* ---------------- outils canvas ---------------- */
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function free(c) { if (c) { c.width = 0; c.height = 0; } }
function scaled(src, maxSide) {
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = canvas(Math.max(1, Math.round(src.width * k)), Math.max(1, Math.round(src.height * k)));
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
/** Dimensions (orientation EXIF appliquée) sans décoder les pixels. */
function dimensions(file) {
  const url = URL.createObjectURL(file), img = new Image();
  return new Promise(res => {
    img.onload = () => res([img.naturalWidth, img.naturalHeight]);
    img.onerror = () => res(null);
    img.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}
async function decode(file) {
  // Photo de 48 Mpx : décodée directement à MAX_SIDE (≈ 190 Mo de pixels évités sur mobile).
  // Un seul côté est imposé : l'autre suit le rapport, que le navigateur applique la réduction
  // avant ou après l'orientation EXIF.
  const d = await dimensions(file);
  if (d && Math.max(...d) > MAX_SIDE) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: Math.round(d[0] * MAX_SIDE / Math.max(...d)), resizeQuality: 'high' }); }
    catch { /* option non prise en charge : décodage complet ci-dessous */ }
  }
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); return img; }
    catch { throw new Error('format de photo non pris en charge par ce navigateur'); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}

/* ---------------- personnes (emplacements) ---------------- */
const slots = [0, 1, 2].map(i => ({ i, status: 'vide', adj: { ...ADJ0 }, coches: {} }));
let sel = 0;
const actifs = () => (G.mode === 'trio' ? slots : slots.slice(0, 1));

function renderSlots() {
  const box = $('slots');
  const focus = [...box.children].findIndex(c => c.contains(document.activeElement));
  box.replaceChildren();
  for (const s of actifs()) {
    const el = document.createElement('div');
    el.className = 'slot' + (s.i === sel && s.status === 'ok' ? ' sel' : '');
    el.setAttribute('role', 'group');
    const nom = G.mode === 'trio' ? `Personne ${s.i + 1}` : 'Photo';
    const etat = { vide: 'Aucune photo', analyse: 'Analyse en cours…', ok: 'Prête — clique pour régler', err: '⚠️ ' + (s.err || 'échec') }[s.status];
    el.innerHTML = `<div class="ph">＋</div><div class="info"><strong></strong><span></span></div>
      <div class="slot-btns"><label class="btn ghost small">Choisir…<input type="file" accept="image/*"></label>${cameraDisponible() ? '<button type="button" class="btn ghost small cam">Caméra</button>' : ''}</div>`;
    el.querySelector('strong').textContent = nom;
    el.setAttribute('aria-label', `${nom} : ${etat}`);
    const inp = el.querySelector('input');
    inp.setAttribute('aria-label', `Choisir la photo — ${nom} (${etat})`);
    // clavier : arriver sur « Choisir… » d'une personne prête la sélectionne pour les réglages
    inp.onfocus = () => { if (s.status === 'ok' && sel !== s.i) { sel = s.i; refresh(); markSel(); } };
    el.querySelector('span').textContent = etat;
    if (s.thumb) { const c = canvas(56, 72); c.getContext('2d').drawImage(s.thumb, 0, 0, 56, 72); el.querySelector('.ph').replaceWith(c); }
    el.querySelector('input').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) charger(s, f); };
    const cam = el.querySelector('.cam');
    if (cam) { cam.setAttribute('aria-label', `Prendre la photo avec la caméra — ${nom}`); cam.onclick = () => { if (cam.disabled) return; cam.disabled = true; ouvrirCamera().then(f => { if (f) charger(s, f); }).finally(() => { cam.disabled = false; }); }; }
    el.onclick = e => { if (e.target.closest('label, button')) return; if (s.status === 'ok') { sel = s.i; refresh(); } };
    el.ondragover = e => e.preventDefault();
    el.ondrop = e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) charger(s, f); };
    box.appendChild(el);
  }
  if (focus >= 0) box.children[focus]?.querySelector('input')?.focus({ preventScroll: true });
}
function markSel() { actifs().forEach((s, k) => box_(k)?.classList.toggle('sel', s.i === sel && s.status === 'ok')); }
const box_ = k => $('slots').children[k];

async function charger(s, file) {
  s.status = 'analyse'; s.err = null; s.file = file; s.adj = { ...ADJ0 }; s.coches = {}; s.mesure = null; s.thumb = null;
  s.ver = (s.ver || 0) + 1; free(s.rc?.canvas); s.rc = null;
  const tok = s.tok = {};
  sel = s.i; renderSlots(); refresh();
  try {
    await analyser(s, tok);
    if (s.tok !== tok) return;
    s.status = 'ok';
    autoReglages(s);
  } catch (e) {
    if (s.tok !== tok) return;
    console.error(e); s.status = 'err'; s.err = String(e.message || e);
    s.cut?.close?.(); s.cut = null;
  }
  setBar(null); setStatus('');
  renderSlots(); refresh();
}

/** Analyse : visage, repères, netteté, détourage de la zone de la photo. */
async function analyser(s, tok) {
  setStatus('Recherche du visage…');
  const bmp = await decode(s.file);
  const src = scaled(bmp, MAX_SIDE); bmp.close?.();
  try {
    const W = src.width, H = src.height;
    const f = await chercherVisage(src, () => s.tok !== tok);
    if (s.tok !== tok) return;
    if (!f.nb) throw new Error('aucun visage détecté : photo de face, bien éclairée (ou plus serrée sur le visage)');
    if (s.tok !== tok) return;
    const r = reperes(f.lm, W, H);
    const nettete_ = mesureNettete(src, r);
    setStatus('Analyse des cheveux…');
    const cheveux = await cheveuxTete(src, r);
    if (s.tok !== tok) return;
    // Zone à détourer : le plus grand cadre possible (visage minimal, décalages maximaux), redressé
    const c = cadre(r, { visageMm: 32, dx: 0, dy: 0 });
    const pad = 4 * c.pxParMm;  // marge pour les décalages (±3 mm) et l'arrondi
    const a = c.angle * Math.PI / 180, ca = Math.cos(-a), sa = Math.sin(-a);
    const xs = [], ys = [];
    for (const [x, y] of [[c.x - pad, c.y - pad], [c.x + c.w + pad, c.y - pad], [c.x - pad, c.y + c.h + pad], [c.x + c.w + pad, c.y + c.h + pad]]) {
      const dx = x - c.cx, dy = y - c.cy;          // repère redressé → image source
      xs.push(c.cx + dx * ca - dy * sa); ys.push(c.cy + dx * sa + dy * ca);
    }
    const reg = { x: Math.max(0, Math.floor(Math.min(...xs))), y: Math.max(0, Math.floor(Math.min(...ys))) };
    reg.w = Math.min(W, Math.ceil(Math.max(...xs))) - reg.x; reg.h = Math.min(H, Math.ceil(Math.max(...ys))) - reg.y;
    await ensureModel();
    if (s.tok !== tok) return;
    setStatus('Détourage en cours… (jusqu’à quelques minutes sans accélération graphique)');
    const m = canvas(RES, RES), mx = m.getContext('2d', { willReadFrequently: true });
    mx.imageSmoothingQuality = 'high'; mx.drawImage(src, reg.x, reg.y, reg.w, reg.h, 0, 0, RES, RES);
    const raw = await infer(mx.getImageData(0, 0, RES, RES).data); free(m);
    if (s.tok !== tok) return;
    const rk = Math.min(1, MAX_REGION / Math.max(reg.w, reg.h));
    const rw = Math.round(reg.w * rk), rh = Math.round(reg.h * rk);
    const rc = canvas(rw, rh), rx = rc.getContext('2d', { willReadFrequently: true });
    rx.imageSmoothingQuality = 'high'; rx.drawImage(src, reg.x, reg.y, reg.w, reg.h, 0, 0, rw, rh);
    const px = rx.getImageData(0, 0, rw, rh).data; free(rc);
    const mask = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) mask[i] = Math.round(raw[i] * 255);
    setStatus('Nettoyage des contours (cheveux)…');
    const rgba = await matte(px, rw, rh, mask);
    if (s.tok !== tok) return;
    // Haut réel de la tête (chevelure comprise) : borne l'estimation du sommet du crâne
    // Si la tête touche le bord haut de la photo d'origine, le vrai sommet est inconnu.
    const ht = hautTete(rgba, rw, rh, r, reg, rk, cheveux);
    if (ht.bord) r.crane = 'estime'; else sommetCrane(r, ht.t, ht.cheveux, ht.peau);
    const cut = await createImageBitmap(new ImageData(new Uint8ClampedArray(rgba.buffer), rw, rh));
    if (s.tok !== tok) { cut.close(); return; }
    s.cut?.close?.();
    // diag : mesures brutes, pour le débogage (?debug) et l'étalonnage
    Object.assign(s, { W, H, r, blend: f.blend, nb: f.nb, nettete: nettete_, cut, reg, hautCoupe: ht.bord, diag: { yeuxHaut: ht.t, cheveuxHaut: ht.cheveux, peauHaut: ht.peau, yeuxMenton: r.yeuxMenton } });
  } finally { free(src); }
}

/**
 * Visage sur toute l'image, puis, s'il est trop petit pour le détecteur (photo en pied, de loin),
 * sur des zones de plus en plus petites. Les repères sont ramenés aux coordonnées de l'image entière.
 * `annule()` vrai : une autre photo a été chargée entre-temps, on arrête.
 */
async function chercherVisage(src, annule = () => false) {
  const W = src.width, H = src.height;
  const essai = async (x, y, w, h) => {
    const k = Math.min(1, 1600 / Math.max(w, h));
    const c = canvas(Math.round(w * k), Math.round(h * k)), cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high'; cx.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
    const f = await analyserVisage(c); free(c);
    if (f.nb) f.lm = f.lm.map(p => ({ x: (x + p.x * w) / W, y: (y + p.y * h) / H, z: p.z }));
    return f;
  };
  let f = await essai(0, 0, W, H);
  if (f.nb) return f;
  setStatus('Visage petit sur la photo : recherche par zones…');
  for (const part of [0.6, 0.4]) {
    const cote = Math.min(W, H) * part, pas = cote / 2;
    let best = null;
    for (let y = 0; y + cote <= H + 1; y += pas) for (let x = 0; x + cote <= W + 1; x += pas) {
      if (annule()) return { nb: 0 };
      f = await essai(Math.min(x, W - cote), Math.min(y, H - cote), cote, cote);
      // le visage doit être entièrement dans la zone : repères tous loin des bords
      if (f.nb && f.lm.every(p => p.x * W > x + 2 && p.x * W < x + cote - 2 && p.y * H > y + 2 && p.y * H < y + cote - 2)) {
        const taille = Math.abs(f.lm[152].y - f.lm[10].y);
        if (!best || taille > best.taille) best = { ...f, taille };
      }
    }
    if (best) return best;
  }
  return { nb: 0 };
}

/** Probabilité « cheveux » sur un carré autour de la tête (512 px). null si indisponible. */
async function cheveuxTete(src, r) {
  const cote = 3.4 * r.yeuxMenton, x = r.yeux.x - cote / 2, y = r.yeux.y - 0.62 * cote;
  const c = canvas(512, 512), cx = c.getContext('2d');
  cx.fillStyle = '#000'; cx.fillRect(0, 0, 512, 512);
  cx.drawImage(src, x, y, cote, cote, 0, 0, 512, 512);
  const m = await segmenterCheveux(c); free(c);
  if (!m) return null;
  const k = m.w / cote;
  return (sx, sy) => {
    const px = Math.floor((sx - x) * k), py = Math.floor((sy - y) * k);
    return px < 0 || py < 0 || px >= m.w || py >= m.h ? null : m.data[py * m.w + px];
  };
}

/**
 * Distance (px source, repère redressé) entre la ligne des yeux et le haut de la tête détourée,
 * mesurée le long de la verticale du visage (perpendiculaire à la ligne des yeux), sur une bande
 * centrale. Renvoie { t (null si introuvable), bord, cheveux, peau } : bord = la tête atteint le
 * bord haut de la photo d'origine ; cheveux = probabilité moyenne « cheveux » sous le haut ;
 * peau = le haut de la tête a la couleur du front (pas un bonnet, un foulard…).
 */
function hautTete(rgba, w, h, r, reg, rk, cheveux = null) {
  const a = r.roulis * Math.PI / 180, upx = Math.sin(a), upy = -Math.cos(a), ux = Math.cos(a), uy = Math.sin(a);
  const e = Math.hypot(r.iG.x - r.iD.x, r.iG.y - r.iD.y);
  const alpha = (x, y) => {
    const px = Math.round((x - reg.x) * rk), py = Math.round((y - reg.y) * rk);
    return px < 0 || py < 0 || px >= w || py >= h ? 0 : rgba[(py * w + px) * 4 + 3];
  };
  let best = null, bord = false, bestOff = 0;
  const pas = Math.max(1, 1 / rk);
  const trou = Math.max(6 * pas, 0.05 * e);   // mèches fines : petits trous tolérés
  for (const off of [-0.3, -0.15, 0, 0.15, 0.3]) {
    const bx = r.yeux.x + ux * off * e, by = r.yeux.y + uy * off * e;
    let last = null;
    for (let t = 0; t < 3 * r.yeuxMenton; t += pas) {
      if (by + upy * t < 0) { if (last != null && t - last <= trou) bord = true; break; }  // sortie par le haut de la photo
      if (alpha(bx + upx * t, by + upy * t) > 128) last = t;
      else if (last != null && t - last > trou) break;   // fin de la tête
    }
    if (last != null && (best == null || last > best)) { best = last; bestOff = off; }
  }
  // Cheveux sur le haut de la tête ? moyenne sur une bande sous le haut détouré (3 colonnes)
  let ch = null;
  if (cheveux && best != null) {
    let s = 0, n = 0;
    for (const off of [bestOff - 0.15, bestOff, bestOff + 0.15]) for (let t = best - 0.1 * r.yeuxMenton; t <= best - 0.01 * r.yeuxMenton; t += 0.01 * r.yeuxMenton) {
      const v = cheveux(r.yeux.x + ux * off * e + upx * t, r.yeux.y + uy * off * e + upy * t);
      if (v != null) { s += v; n++; }
    }
    ch = n ? s / n : null;
  }
  // Couleur du haut de la tête comparée à celle du front (chromaticité r, g normalisées)
  let peau = false;
  if (best != null) {
    const couleur = pts => {
      let R = 0, G = 0, B = 0, n = 0;
      for (const [x, y] of pts) {
        const px = Math.round((x - reg.x) * rk), py = Math.round((y - reg.y) * rk);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const i = (py * w + px) * 4; if (rgba[i + 3] < 200) continue;
        R += rgba[i]; G += rgba[i + 1]; B += rgba[i + 2]; n++;
      }
      const S = R + G + B;
      return n && S ? [R / S, G / S] : null;
    };
    const pts = (t0, t1, offs) => { const o = []; for (const off of offs) for (let t = t0; t <= t1; t += 0.01 * r.yeuxMenton) o.push([r.yeux.x + ux * off * e + upx * t, r.yeux.y + uy * off * e + upy * t]); return o; };
    const haut = couleur(pts(best - 0.12 * r.yeuxMenton, best - 0.03 * r.yeuxMenton, [bestOff - 0.15, bestOff, bestOff + 0.15]));
    const front = couleur(pts(0.35 * r.yeuxMenton, 0.5 * r.yeuxMenton, [-0.2, 0, 0.2]));
    peau = !!(haut && front && Math.hypot(haut[0] - front[0], haut[1] - front[1]) < 0.035);
  }
  return { t: best, bord, cheveux: ch, peau };
}

/**
 * Netteté sur le visage ramené à 256 px de large au plus (jamais agrandi : l'agrandissement
 * flouterait la mesure). Comparable entre photos pour les visages d'au moins 256 px ; en dessous,
 * la mesure baisse avec la résolution, laquelle est de toute façon contrôlée à part.
 */
function mesureNettete(src, r) {
  const e = Math.hypot(r.iG.x - r.iD.x, r.iG.y - r.iD.y);
  const x = r.yeux.x - 1.1 * e, y = r.yeux.y - 0.6 * e, w = 2.2 * e, h = 0.6 * e + r.yeuxMenton;
  const tw = Math.max(16, Math.round(Math.min(256, w))), th = Math.max(16, Math.round(tw * h / w));  // jamais d'agrandissement
  const c = canvas(tw, th), cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(src, x, y, w, h, 0, 0, tw, th);
  const d = cx.getImageData(0, 0, tw, th).data; free(c);
  const g = new Float32Array(tw * th);
  for (let i = 0, p = 0; p < g.length; p++, i += 4) g[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  return nettete(g, tw, th);
}

/* ---------------- rendu d'une photo 35×45 ---------------- */
/**
 * Photo 35×45 à `dpi`. Renvoie { canvas, lumPeau, asym, rMoy, bMoy, c }.
 * Les réglages de lumière ne touchent que le sujet ; le fond est une couleur unie.
 */
function rendre(s, dpi, { mesurer = false, brut = false } = {}) {
  const [OW, OH] = taillePhoto(dpi);
  const c = cadre(s.r, { visageMm: s.adj.visage, dx: s.adj.dx, dy: s.adj.dy });
  const k = OW / c.w;
  const sujet = canvas(OW, OH), sx = sujet.getContext('2d', { willReadFrequently: true });
  sx.imageSmoothingQuality = 'high';
  sx.setTransform(k, 0, 0, k, -c.x * k, -c.y * k);
  sx.translate(c.cx, c.cy); sx.rotate(c.angle * Math.PI / 180); sx.translate(-c.cx, -c.cy);
  sx.drawImage(s.cut, s.reg.x, s.reg.y, s.reg.w, s.reg.h);
  sx.setTransform(1, 0, 0, 1, 0, 0);
  const img = sx.getImageData(0, 0, OW, OH);
  if (!brut) appliquer(img.data, s.adj);
  const out = { c, canvas: null };
  if (mesurer) {
    // front + haut des joues (repère redressé : les yeux sont le centre de rotation)
    const z = zonesPeau(s.r), X = x => (x - c.x) * k, Y = y => (y - c.y) * k;
    const L = ([x0, y0, x1, y1]) => lumZone(img.data, OW, OH, X(x0), Y(y0), X(x1), Y(y1));
    const lf = L(z.front), lD = L(z.joueD), lG = L(z.joueG);
    const vals = [lf, lD, lG].filter(v => v != null);
    out.lumPeau = vals.length ? vals.reduce((p, q) => p + q, 0) / vals.length : null;
    out.asym = lD && lG ? Math.max(lD, lG) / Math.max(1e-3, Math.min(lD, lG)) : null;
    const ec = [z.front, z.joueD, z.joueG].map(([x0, y0, x1, y1]) => ecretage(img.data, OW, OH, X(x0), Y(y0), X(x1), Y(y1))).filter(Boolean);
    out.brule = ec.length ? Math.max(...ec.map(v => v.brule)) : 0;
    out.bouche = ec.length ? Math.max(...ec.map(v => v.bouche)) : 0;
    // bande centrale (40 % de la largeur) : cheveux sur la première ligne ? sujet absent de la dernière ?
    const cx0 = Math.round(OW * 0.3), cx1 = Math.round(OW * 0.7);
    let haut = 0, bas = 0;
    for (let x = cx0; x < cx1; x++) { if (img.data[x * 4 + 3] > 128) haut++; if (img.data[((OH - 1) * OW + x) * 4 + 3] > 128) bas++; }
    out.cheveuxCoupes = haut / (cx1 - cx0) > 0.05;
    out.basVide = bas / (cx1 - cx0) < 0.5;
  }
  sx.putImageData(img, 0, 0);
  const fin = canvas(OW, OH), fx = fin.getContext('2d');
  fx.fillStyle = FONDS[G.fond].hex; fx.fillRect(0, 0, OW, OH);
  fx.drawImage(sujet, 0, 0); free(sujet);
  out.canvas = fin;
  return out;
}

function autoReglages(s) {
  const m = rendre(s, 150, { mesurer: true, brut: true });
  free(m.canvas);
  // Exposition seulement si elle sort de la plage acceptable ; ombres si une moitié du visage
  // est nettement plus sombre. Pas d'équilibre des blancs automatique (peu fiable sur la peau).
  s.adj.exposition = +expositionAuto(m.lumPeau).toFixed(2);
  s.adj.ombres = m.asym && m.asym > 1.25 ? Math.min(0.5, +((m.asym - 1) * 0.8).toFixed(2)) : 0;
}

/* ---------------- interface ---------------- */
const SLIDERS = { visage: v => `${v.toFixed(1)} mm`, dx: v => `${v.toFixed(1)} mm`, dy: v => `${v.toFixed(1)} mm`,
  exposition: v => (v > 0 ? '+' : '') + v.toFixed(2), contraste: v => (v > 0 ? '+' : '') + v.toFixed(2), ombres: v => v.toFixed(2),
  temperature: v => (v > 0 ? '+' : '') + v.toFixed(2), saturation: v => (v > 0 ? '+' : '') + v.toFixed(2) };
for (const id of Object.keys(SLIDERS)) {
  $(id).addEventListener('input', e => { const s = slots[sel]; if (s.status !== 'ok') return; s.adj[id] = +e.target.value; schedule(); });
}
$('auto').onclick = () => { const s = slots[sel]; if (s.status !== 'ok') return; const keep = { visage: s.adj.visage, dx: s.adj.dx, dy: s.adj.dy }; s.adj = { ...ADJ0, ...keep }; autoReglages(s); refresh(); };
$('raz').onclick = () => { const s = slots[sel]; if (s.status !== 'ok') return; s.adj = { ...ADJ0 }; refresh(); };
$('guides').onchange = () => refresh();
for (const [k, f] of Object.entries(FONDS)) $('fond').add(new Option(f.nom, k));
$('fond').onchange = e => { G.fond = e.target.value; persist(); refresh(); };
$('mode').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.dataset.v === G.mode) return;
  G.mode = b.dataset.v; persist(); if (sel >= actifs().length) sel = 0; renderSlots(); refresh();
});
$('manuel').addEventListener('change', e => { const s = slots[sel]; if (e.target.dataset.id) { s.coches[e.target.dataset.id] = e.target.checked; refreshConformite(); } });

let raf = 0;
function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(refresh); }

function refresh() {
  [...$('mode').children].forEach(b => { b.classList.toggle('on', b.dataset.v === G.mode); b.setAttribute('aria-pressed', b.dataset.v === G.mode); });
  $('fond').value = G.fond; $('fondSw').style.background = FONDS[G.fond].hex;
  const s = slots[sel];
  const ok = s.status === 'ok';
  $('reglages').hidden = !ok; $('editor').hidden = !ok;
  if (ok) {
    $('regNom').textContent = G.mode === 'trio' ? `la personne ${s.i + 1}` : 'la photo';
    for (const [id, fmt] of Object.entries(SLIDERS)) { $(id).value = s.adj[id]; $(id + 'V').textContent = fmt(s.adj[id]); }
    dessinerApercu(s);
  }
  dessinerPlanche();
  refreshConformite();
}

function dessinerApercu(s) {
  const m = rendre(s, 254, { mesurer: true });   // 254 dpi : 350×450 px, soit 10 px par mm
  s.mesure = m;
  const cv = $('apercu'), x = cv.getContext('2d');
  x.drawImage(m.canvas, 0, 0, cv.width, cv.height); free(m.canvas); m.canvas = null;
  const t = canvas(112, 144); t.getContext('2d').drawImage(cv, 0, 0, 112, 144);  // vignette sans repères
  s.thumb = t;
  if ($('guides').checked) {
    const mm = cv.width / NORME.largeurMm, me = mesures(s.r, m.c);
    // zone des yeux (50 à 70 % de la hauteur depuis le bas)
    x.fillStyle = 'rgba(30,140,80,.16)';
    x.fillRect(0, (1 - NORME.yeuxBasMax) * NORME.hauteurMm * mm, cv.width, (NORME.yeuxBasMax - NORME.yeuxBasMin) * NORME.hauteurMm * mm);
    x.font = '11px system-ui'; x.fillStyle = 'rgba(20,90,50,.9)'; x.fillText('zone des yeux', 6, (1 - NORME.yeuxBasMax) * NORME.hauteurMm * mm + 13);
    // hauteur du visage : sommet du crâne → menton
    const okV = me.visageMm >= NORME.visageMinMm && me.visageMm <= NORME.visageMaxMm;  // valeur estimée
    x.strokeStyle = okV ? 'rgba(20,130,70,.9)' : 'rgba(180,40,30,.9)'; x.lineWidth = 1.5; x.setLineDash([5, 4]);
    for (const y of [me.craneMm, me.mentonMm]) { x.beginPath(); x.moveTo(cv.width * .2, y * mm); x.lineTo(cv.width * .8, y * mm); x.stroke(); }
    x.setLineDash([]);
    x.beginPath(); x.moveTo(cv.width - 14, me.craneMm * mm); x.lineTo(cv.width - 14, me.mentonMm * mm); x.stroke();
    x.save(); x.translate(cv.width - 18, (me.craneMm + me.mentonMm) / 2 * mm); x.rotate(-Math.PI / 2);
    x.fillStyle = x.strokeStyle; x.textAlign = 'center'; x.fillText(`${s.r.crane === 'mesure' ? '' : '≈ '}${me.visageMm.toFixed(1)} mm`, 0, 0); x.restore();
    // axe vertical
    x.strokeStyle = 'rgba(30,58,95,.35)'; x.setLineDash([2, 4]);
    x.beginPath(); x.moveTo(cv.width / 2, 0); x.lineTo(cv.width / 2, cv.height); x.stroke(); x.setLineDash([]);
  }
  const slotCanvas = $('slots').children[actifs().indexOf(s)]?.querySelector('canvas');
  if (slotCanvas) slotCanvas.getContext('2d').drawImage(t, 0, 0, 56, 72); else renderSlots();
}

function etatControles(s) {
  if (s.status !== 'ok') return null;
  if (!s.mesure) { const m = rendre(s, 150, { mesurer: true }); free(m.canvas); m.canvas = null; s.mesure = m; }
  const m = s.mesure;
  return controles({ nbVisages: s.nb, r: s.r, c: m.c, blend: s.blend, lumPeau: m.lumPeau, brule: m.brule, bouche: m.bouche, asym: m.asym,
    nettete: s.nettete, fond: FONDS[G.fond].hex, cheveuxCoupes: m.cheveuxCoupes, basVide: m.basVide, hautCoupe: s.hautCoupe });
}

function refreshConformite() {
  const s = slots[sel];
  if (s.status === 'ok') {
    const res = etatControles(s);
    $('checks').replaceChildren(...res.map(c => {
      const li = document.createElement('li'); li.className = c.ok === true ? 'ok' : c.ok === false ? 'ko' : 'info';
      li.append(c.texte); if (c.detail) { const sm = document.createElement('small'); sm.textContent = ' — ' + c.detail; li.append(sm); }
      return li;
    }));
    $('manuel').replaceChildren(...A_COCHER.map(q => {
      const li = document.createElement('li'), lab = document.createElement('label'), cb = document.createElement('input');
      cb.type = 'checkbox'; cb.dataset.id = q.id; cb.checked = !!s.coches[q.id];
      lab.append(cb, q.texte); li.append(lab); return li;
    }));
  }
  // synthèse sur toutes les photos de la planche
  const prets = actifs().every(x => x.status === 'ok');
  let ko = 0, nonCoche = 0;
  for (const x of actifs()) if (x.status === 'ok') {
    ko += etatControles(x).filter(c => c.ok === false).length;
    nonCoche += A_COCHER.filter(q => !x.coches[q.id]).length;
  }
  const el = $('conformite');
  for (const id of ['dlPlanche', 'dlPlancheHD']) $(id).disabled = !prets;
  $('dlPhoto').disabled = slots[sel].status !== 'ok';
  if (!prets) { el.className = 'hint'; el.textContent = G.mode === 'trio' ? 'Ajoute les 3 photos pour compléter la planche.' : ''; return; }
  if (ko) { el.className = 'hint ko'; el.textContent = `${ko} point${ko > 1 ? 's' : ''} non conforme${ko > 1 ? 's' : ''} : corrige-les avant d'imprimer (ou refais la photo).`; }
  else if (nonCoche) { el.className = 'hint'; el.textContent = `Contrôles automatiques réussis. Il reste ${nonCoche} point${nonCoche > 1 ? 's' : ''} à vérifier toi-même (liste à cocher).`; }
  else { el.className = 'hint ok'; el.textContent = 'Tous les contrôles sont réussis : planche prête à imprimer.'; }
}

/* ---------------- planche ---------------- */
function construirePlanche(dpi) {
  const p = planche(dpi, G.mode);
  const cv = canvas(p.W, p.H), x = cv.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, p.W, p.H);
  const cache = new Map();
  for (const ph of p.photos) {
    const s = actifs()[ph.source];
    if (s?.status === 'ok') {
      if (!cache.has(s.i)) cache.set(s.i, rendu(s, dpi));
      x.drawImage(cache.get(s.i), ph.x, ph.y, ph.w, ph.h);
    } else {
      x.fillStyle = '#eceff2'; x.fillRect(ph.x, ph.y, ph.w, ph.h);
      x.fillStyle = '#8a95a3'; x.font = `${Math.round(dpi / 12)}px system-ui`; x.textAlign = 'center';
      x.fillText(G.mode === 'trio' ? `Personne ${ph.source + 1}` : 'Photo', ph.x + ph.w / 2, ph.y + ph.h / 2);
    }
  }
  if (dpi !== NORME.dpiPlanche) for (const c of cache.values()) free(c);   // les rendus d'aperçu restent en cache
  // repères de coupe
  x.strokeStyle = '#9aa3ad'; x.lineWidth = Math.max(1, dpi / 254); x.beginPath();
  for (const [x1, y1, x2, y2] of p.traits) { x.moveTo(x1, y1); x.lineTo(x2, y2); }
  x.stroke();
  // barre d'échelle 10 mm
  x.strokeStyle = '#333'; x.lineWidth = Math.max(1.5, dpi / 170);
  const e = p.echelle, t = dpi / 50;
  x.beginPath(); x.moveTo(e.x, e.y1); x.lineTo(e.x, e.y2); x.moveTo(e.x - t, e.y1); x.lineTo(e.x + t, e.y1); x.moveTo(e.x - t, e.y2); x.lineTo(e.x + t, e.y2); x.stroke();
  x.save(); x.translate(e.x + dpi / 12, (e.y1 + e.y2) / 2); x.rotate(-Math.PI / 2);
  x.fillStyle = '#555'; x.font = `${Math.round(dpi / 22)}px system-ui`; x.textAlign = 'center'; x.fillText('10 mm', 0, 0); x.restore();
  return cv;
}
/** Rendu d'une photo ; mis en cache à la résolution de la planche affichée (évite de tout refaire à chaque mouvement de curseur). */
function rendu(s, dpi) {
  if (dpi !== NORME.dpiPlanche) return rendre(s, dpi).canvas;
  const key = JSON.stringify([s.ver, s.adj, G.fond]);
  if (s.rc?.key !== key) { free(s.rc?.canvas); s.rc = { key, canvas: rendre(s, dpi).canvas }; }
  return s.rc.canvas;
}
let plancheKey = '';
function dessinerPlanche() {
  const any = actifs().some(s => s.status === 'ok');
  $('empty').hidden = any;
  const cv = $('planche');
  const key = JSON.stringify([G.mode, G.fond, actifs().map(s => [s.status, s.ver, s.adj])]);
  if (key === plancheKey) return;
  plancheKey = key;
  if (!any) { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); return; }
  const p = construirePlanche(NORME.dpiPlanche);
  cv.getContext('2d').drawImage(p, 0, 0); free(p);
}

/* ---------------- exports ---------------- */
async function telecharger(fabrique, dpi, nom) {
  let cv = null;
  try {
    cv = fabrique();
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.95));
    if (!blob) throw new Error('encodage JPEG impossible');
    const bytes = jpegDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })); a.download = nom;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) { console.error(e); toast("L'export a échoué : " + (e.message || e)); }
  finally { free(cv); }
}
/** Nombre de contrôles en échec sur les photos concernées. */
function nbKo(liste) { return liste.filter(x => x.status === 'ok').reduce((n, x) => n + etatControles(x).filter(c => c.ok === false).length, 0); }
// Export malgré des défauts : un second clic dans les 6 s confirme (pas de boîte de dialogue bloquante).
let armeExport = null, armeT = 0;
function confirmer(id, liste) {
  const ko = nbKo(liste);
  if (!ko || armeExport === id) { armeExport = null; return true; }
  armeExport = id; clearTimeout(armeT); armeT = setTimeout(() => { armeExport = null; }, 6000);
  toast(`${ko} point${ko > 1 ? 's' : ''} non conforme${ko > 1 ? 's' : ''} : clique à nouveau pour exporter quand même.`);
  return false;
}
$('dlPlanche').onclick = () => { if (confirmer('p', actifs())) telecharger(() => construirePlanche(300), 300, 'photos-identite-10x15.jpg'); };
$('dlPlancheHD').onclick = () => { if (confirmer('h', actifs())) telecharger(() => construirePlanche(600), 600, 'photos-identite-10x15-600dpi.jpg'); };
$('dlPhoto').onclick = () => {
  const s = slots[sel]; if (s.status !== 'ok' || !confirmer('s' + s.i, [s])) return;
  telecharger(() => rendre(s, 600).canvas, 600, G.mode === 'trio' ? `photo-identite-35x45-personne${s.i + 1}.jpg` : 'photo-identite-35x45.jpg');
};

/* ---------------- divers ---------------- */
function setStatus(t) { $('status').textContent = t; }
function setBar(p) { $('bar').hidden = p == null; if (p != null) { $('barI').style.width = (Math.min(1, p) * 100).toFixed(1) + '%'; $('bar').setAttribute('aria-valuenow', Math.round(p * 100)); } }
let toastT = 0;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 3200); }

renderSlots(); refresh();
if (new URLSearchParams(location.search).has('debug')) window.__identite = { slots, G, rendre, construirePlanche, etatControles, charger };
