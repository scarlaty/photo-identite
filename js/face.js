// Détection du visage : MediaPipe Face Landmarker (478 points, iris inclus, et « blendshapes »
// pour les yeux, la bouche et le sourire).

const VERSION = '0.10.35';
const LIB = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let detP = null;
function detecteur() {
  if (!detP) {
    detP = (async () => {
      const { FilesetResolver, FaceLandmarker } = await import(`${LIB}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${LIB}/wasm`);
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 3,                     // pour signaler la présence de plusieurs visages
        outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.5,
      });
    })();
    detP.catch(() => { detP = null; });
  }
  return detP;
}

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
  const nb = faces.filter(f => Math.abs(f[152].y - f[10].y) > taille * 0.35).length;
  return { nb, lm: faces[best], blend };
}
