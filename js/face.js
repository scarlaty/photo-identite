/**
 * Nombre de visages « autres personnes » : un visage compte s'il fait au moins 35 % de la taille du
 * principal, ne le chevauche pas (détection en double) et n'est pas sur sa poitrine (logo, imprimé).
 */
export function compterVisages(faces, best) {
  const box = f => { let x0 = 1, y0 = 1, x1 = 0, y1 = 0; for (const p of f) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; } return { x0, y0, x1, y1 }; };
  const B = box(faces[best]), taille = B.y1 - B.y0, larg = B.x1 - B.x0;
  return 1 + faces.filter((f, i) => {
    if (i === best) return false;
    const b = box(f);
    if (b.y1 - b.y0 < 0.35 * taille) return false;
    const ix = Math.max(0, Math.min(b.x1, B.x1) - Math.max(b.x0, B.x0)), iy = Math.max(0, Math.min(b.y1, B.y1) - Math.max(b.y0, B.y0));
    const inter = ix * iy, union = (b.x1 - b.x0) * (b.y1 - b.y0) + larg * taille - inter;
    if (inter / union > 0.3) return false;
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    // sur la poitrine et nettement plus petit : imprimé ou logo (un enfant tenu devant, de taille proche, compte)
    if (cy > B.y1 && Math.abs(cx - (B.x0 + B.x1) / 2) < 1.5 * larg && b.y1 - b.y0 < 0.7 * taille) return false;
    return true;
  }).length;
}

// Détection du visage : MediaPipe Face Landmarker (478 points, iris inclus, et « blendshapes »
// pour les yeux, la bouche et le sourire) et segmentation des cheveux (Hair Segmenter), qui
// permet de savoir si le haut de la tête est dégagé (crâne mesurable) ou couvert de cheveux.

const VERSION = '0.10.35';
const LIB = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_CHEVEUX = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/latest/hair_segmenter.tflite';

let libP = null;
function bibliotheque() {
  if (!libP) {
    libP = (async () => {
      const lib = await import(`${LIB}/vision_bundle.mjs`);
      return { lib, fileset: await lib.FilesetResolver.forVisionTasks(`${LIB}/wasm`) };
    })();
    libP.catch(() => { libP = null; });
  }
  return libP;
}

/** Charge un moteur une seule fois, avec un délai : jamais d'attente infinie. */
function chargeur(creer, nom, ms = 120_000) {
  let p = null;
  return () => {
    if (!p) {
      let t = 0;
      const delai = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${nom} ne se charge pas (connexion ?) : réessaie`)), ms); });
      p = Promise.race([bibliotheque().then(creer), delai]).finally(() => clearTimeout(t));
      p.catch(() => { p = null; });
    }
    return p;
  };
}

const detecteur = chargeur(({ lib, fileset }) => lib.FaceLandmarker.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
  runningMode: 'IMAGE',
  numFaces: 3,                     // pour signaler la présence de plusieurs visages
  outputFaceBlendshapes: true,
  minFaceDetectionConfidence: 0.5,
}), 'le détecteur de visage');

const segmenteur = chargeur(({ lib, fileset }) => lib.ImageSegmenter.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: MODEL_CHEVEUX, delegate: 'CPU' },
  runningMode: 'IMAGE',
  outputCategoryMask: false,
  outputConfidenceMasks: true,
}), 'la segmentation des cheveux', 30_000);
let cheveuxIndispo = false;   // échec une fois : on n'attend plus à chaque photo (repli sur l'estimation)

/**
 * Renvoie { nb, lm, blend } pour le plus grand visage : lm = 478 points normalisés,
 * blend = { eyeBlinkLeft: 0.1, … }. Lève une erreur si le moteur ne se charge pas.
 */
export async function analyserVisage(canvas) {
  const det = await detecteur();
  const res = det.detect(canvas);
  const faces = res.faceLandmarks || [];
  if (!faces.length) return { nb: 0 };
  // le plus grand visage (écart menton–front)
  let best = 0, taille = -1;
  faces.forEach((f, i) => { const t = Math.abs(f[152].y - f[10].y); if (t > taille) { taille = t; best = i; } });
  const blend = {};
  for (const c of res.faceBlendshapes?.[best]?.categories || []) blend[c.categoryName] = c.score;
  // Les visages minuscules (affiche, personne au loin) ne comptent pas comme « autre visage ».
  return { nb: compterVisages(faces, best), lm: faces[best], blend };
}

/**
 * Probabilité « cheveux » (0..1) de chaque pixel de `canvas` (recadré sur la tête par l'appelant).
 * Renvoie { w, h, data: Float32Array } ou null si la segmentation échoue (fonction facultative :
 * l'outil retombe alors sur l'estimation du sommet du crâne).
 */
export async function segmenterCheveux(canvas) {
  if (cheveuxIndispo) return null;
  try {
    const seg = await segmenteur();
    const res = seg.segment(canvas);
    const masks = res.confidenceMasks || [];
    const m = masks[masks.length - 1];       // dernière classe : cheveux
    const out = m ? { w: m.width, h: m.height, data: Float32Array.from(m.getAsFloat32Array()) } : null;
    res.close?.();
    return out;
  } catch (e) {
    console.warn('segmentation des cheveux indisponible :', e);
    cheveuxIndispo = true;
    return null;
  }
}

// Vidéo : GPU si possible (fluidité), sinon CPU.
const detecteurVideo = chargeur(async ({ lib, fileset }) => {
  const opts = d => ({ baseOptions: { modelAssetPath: MODEL, delegate: d }, runningMode: 'VIDEO', numFaces: 2, outputFaceBlendshapes: true });
  try { return await lib.FaceLandmarker.createFromOptions(fileset, opts('GPU')); }
  catch { return lib.FaceLandmarker.createFromOptions(fileset, opts('CPU')); }
}, 'le détecteur de visage');

/** Prépare le détecteur vidéo (caméra). */
export const preparerVideo = () => detecteurVideo();

/** Repères sur une image de la caméra : { nb, lm, blend } (même forme qu'analyserVisage). */
export function detecterVideo(det, video, ts) {
  const res = det.detectForVideo(video, ts);
  const faces = res.faceLandmarks || [];
  if (!faces.length) return { nb: 0 };
  let best = 0, taille = -1;
  faces.forEach((f, i) => { const t = Math.abs(f[152].y - f[10].y); if (t > taille) { taille = t; best = i; } });
  const blend = {};
  for (const c of res.faceBlendshapes?.[best]?.categories || []) blend[c.categoryName] = c.score;
  return { nb: compterVisages(faces, best), lm: faces[best], blend };
}
