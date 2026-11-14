// Prise de vue guidée par la caméra : aperçu vidéo, ovale de placement, conseils en direct
// (distance, tête droite, regard, expression, lumière) et déclenchement automatique quand
// tout est bon. Renvoie un File JPEG à analyser comme une photo choisie.

import { preparerVideo, detecterVideo } from './face.js';
import { conseils } from './guide.js';
import { zonesPeau } from './norme.js';
import { lumZone } from './retouche.js';

export const cameraDisponible = () => !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;

const STABLE = 12;        // images consécutives conformes avant le compte à rebours
const DECOMPTE = 3;       // secondes

let ouverte = null;   // une seule prise de vue à la fois (double clic sur « Caméra »)

/** Ouvre la caméra dans une boîte de dialogue. Résout avec un File, ou null si annulé. */
export function ouvrirCamera() {
  if (ouverte) return ouverte;
  ouverte = ouvrirDialogue().finally(() => { ouverte = null; });
  return ouverte;
}

function ouvrirDialogue() {
  const retourFocus = document.activeElement;
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'camera';
    dlg.setAttribute('aria-label', 'Prise de vue guidée');
    dlg.innerHTML = `
      <div class="cam-stage">
        <video playsinline muted></video>
        <canvas class="cam-overlay" aria-hidden="true"></canvas>
        <div class="cam-count" aria-hidden="true"></div>
      </div>
      <p class="cam-msg" role="status" aria-live="polite">Démarrage de la caméra…</p>
      <ul class="cam-items"></ul>
      <p class="hint">Face à une fenêtre, fond uni derrière toi si possible, appareil à hauteur des yeux à environ 1,5 m (zoom ×2 si possible).
        La photo se prend toute seule quand tout est vert.</p>
      <div class="actions">
        <button class="btn" data-a="prendre">Prendre maintenant</button>
        <button class="btn ghost" data-a="tourner" hidden>Changer de caméra</button>
        <button class="btn ghost" data-a="fermer">Annuler</button>
      </div>`;
    document.body.appendChild(dlg);
    const video = dlg.querySelector('video'), ov = dlg.querySelector('canvas'), msg = dlg.querySelector('.cam-msg');
    const items = dlg.querySelector('.cam-items'), count = dlg.querySelector('.cam-count');
    const mesure = document.createElement('canvas'), mx = mesure.getContext('2d', { willReadFrequently: true });
    let stream = null, det = null, raf = 0, fini = false, stable = 0, compte = null, facing = 'user', lastTs = -1, frame = 0;
    let jeton = 0, dernierMsg = '';
    const annoncer = t => { if (t !== dernierMsg) { dernierMsg = t; msg.textContent = t; } };   // lecteur d'écran : seulement les changements

    const fermer = file => {
      if (fini) return; fini = true;
      cancelAnimationFrame(raf); clearInterval(compte?.t);
      stream?.getTracks().forEach(t => t.stop()); stream = null;
      dlg.close(); dlg.remove();
      retourFocus?.focus?.({ preventScroll: true });
      resolve(file);
    };
    dlg.addEventListener('cancel', e => { e.preventDefault(); fermer(null); });
    dlg.addEventListener('click', e => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'fermer') fermer(null);
      else if (a === 'prendre') declencher();
      else if (a === 'tourner') { facing = facing === 'user' ? 'environment' : 'user'; demarrer(); }
    });

    async function demarrer() {
      const moi = ++jeton;                      // un démarrage plus récent (changement de caméra) l'emporte
      const actuel = () => moi === jeton && !fini;
      stream?.getTracks().forEach(t => t.stop()); stream = null;
      let s;
      try {
        s = await navigator.mediaDevices.getUserMedia({ audio: false,
          video: { facingMode: facing, width: { ideal: 3840 }, height: { ideal: 2160 } } });
      } catch (e) {
        if (actuel()) annoncer(e.name === 'NotAllowedError' ? 'Accès à la caméra refusé : autorise-le dans le navigateur, ou choisis une photo.' : 'Caméra indisponible : ' + (e.message || e.name));
        return;
      }
      if (!actuel()) { s.getTracks().forEach(t => t.stop()); return; }
      stream = s;
      video.srcObject = stream;
      video.classList.toggle('miroir', facing === 'user');
      await video.play().catch(() => {});
      if (!actuel()) return;
      navigator.mediaDevices.enumerateDevices?.().then(d => {
        const b = dlg.querySelector('[data-a=tourner]'); if (b) b.hidden = d.filter(x => x.kind === 'videoinput').length < 2;
      }).catch(() => {});
      if (!det) {
        annoncer('Chargement du détecteur de visage…');
        try { det = await preparerVideo(); } catch (e) { if (actuel()) annoncer(String(e.message || e) + ' — tu peux quand même prendre la photo.'); return; }
        if (!actuel()) return;
      }
      boucle();
    }

    function boucle() {
      if (fini) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(boucle);
      if (video.readyState < 2 || !det) return;
      if (++frame % 2) return;                       // ~15 analyses par seconde suffisent
      const W = video.videoWidth, H = video.videoHeight;
      let ts = performance.now(); if (ts <= lastTs) ts = lastTs + 1; lastTs = ts;
      let v;
      try { v = detecterVideo(det, video, ts); } catch { return; }
      v.W = W; v.H = H;
      if (v.nb === 1) Object.assign(v, lumiere(v, W, H));
      const g = conseils(v);
      dessiner(g, W, H);
      annoncer(compte ? 'Ne bouge plus…' : g.message);
      items.replaceChildren(...g.items.filter(x => x.id !== 'visage').map(x => {
        const li = document.createElement('li'); li.className = x.ok ? 'ok' : 'ko'; li.textContent = x.texte; return li;
      }));
      stable = g.ok ? stable + 1 : 0;
      if (!g.ok && compte) { clearInterval(compte.t); compte = null; count.textContent = ''; }
      if (g.ok && stable >= STABLE && !compte) {
        compte = { n: DECOMPTE, t: setInterval(() => {
          if (!compte) return;
          if (--compte.n <= 0) { clearInterval(compte.t); compte = null; count.textContent = ''; declencher(); }
          else count.textContent = compte.n;
        }, 1000) };
        count.textContent = DECOMPTE;
      }
    }

    /** Luminosité moyenne et écart entre les joues, sur une image réduite. */
    function lumiere(v, W, H) {
      const k = Math.min(1, 480 / Math.max(W, H)), w = Math.round(W * k), h = Math.round(H * k);
      if (mesure.width !== w || mesure.height !== h) { mesure.width = w; mesure.height = h; }
      mx.drawImage(video, 0, 0, w, h);
      const px = mx.getImageData(0, 0, w, h).data;
      const r = { iD: pt(v.lm[468]), iG: pt(v.lm[473]) };
      function pt(p) { return { x: p.x * w, y: p.y * h }; }
      r.yeux = { x: (r.iD.x + r.iG.x) / 2, y: (r.iD.y + r.iG.y) / 2 };
      const m = pt(v.lm[152]); r.yeuxMenton = Math.hypot(m.x - r.yeux.x, m.y - r.yeux.y);
      const z = zonesPeau(r), L = ([a, b, c, d]) => lumZone(px, w, h, a, b, c, d);
      const f = L(z.front), d = L(z.joueD), g = L(z.joueG);
      const vals = [f, d, g].filter(x => x != null);
      return { lum: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, asym: d && g ? Math.max(d, g) / Math.max(1e-3, Math.min(d, g)) : null };
    }

    /** Ovale de placement (vert quand tout est bon) et zone de cadrage. */
    function dessiner(g, W, H) {
      const rect = video.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      ov.width = Math.round(rect.width * dpr); ov.height = Math.round(rect.height * dpr);
      const x = ov.getContext('2d');
      // vidéo en « contain » : échelle et décalages
      const k = Math.min(ov.width / W, ov.height / H), ox = (ov.width - W * k) / 2, oy = (ov.height - H * k) / 2;
      x.clearRect(0, 0, ov.width, ov.height);
      x.save(); x.translate(ox, oy); x.scale(k, k);
      // ovale cible fixe : tête idéale (yeux→menton = H/4,2), yeux à 45 % de la hauteur, ce qui laisse
      // la place du crâne, des cheveux et des épaules (voir GUIDE.margeHaut / margeBas)
      const d = H / 4.2, cx = W / 2, cy = 0.452 * H;
      x.fillStyle = 'rgba(0,0,0,.35)';
      x.beginPath(); x.rect(0, 0, W, H);
      x.ellipse(cx, cy, d * 0.85, d * 1.25, 0, 0, Math.PI * 2, true); x.fill('evenodd');
      x.lineWidth = Math.max(3, W / 300); x.strokeStyle = g.ok ? '#3fd07f' : '#ffffff';
      x.beginPath(); x.ellipse(cx, cy, d * 0.85, d * 1.25, 0, 0, Math.PI * 2); x.stroke();
      x.restore();
    }

    function declencher() {
      if (fini) return;
      if (video.readyState < 2) { annoncer('Caméra pas encore prête'); return; }
      const W = video.videoWidth, H = video.videoHeight;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      c.getContext('2d').drawImage(video, 0, 0, W, H);          // image non inversée (sens réel)
      c.toBlob(b => { c.width = c.height = 0; fermer(b ? new File([b], 'camera.jpg', { type: 'image/jpeg' }) : null); }, 'image/jpeg', 0.95);
    }

    dlg.showModal();
    demarrer();
  });
}
