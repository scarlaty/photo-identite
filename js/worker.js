// Worker d'inférence : charge un modèle ONNX et calcule un masque 1024×1024.
// Messages reçus :
//   { type: 'load', model }                       → { type: 'progress', loaded, total } … { type: 'ready', backend }
//   { type: 'run', id, pixels (RGBA 1024²) }      → { type: 'mask', id, mask (Float32Array 1024²) }
// En cas d'erreur : { type: 'error', id?, message }

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs';
import { MODELS, RES } from './models.js';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const CACHE = 'detourage-panini-models-v1';
let session = null, spec = null, inputType = 'float32';

async function fetchModel(m) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* Cache API indisponible (navigation privée) */ }
  let hit = null;
  try { hit = cache && await cache.match(m.url); } catch { hit = null; }
  if (hit) {
    post({ type: 'progress', loaded: 1, total: 1, cached: true });
    return { bytes: new Uint8Array(await hit.arrayBuffer()), cache, fromCache: true };
  }
  const r = await fetch(m.url);
  if (!r.ok) throw new Error(`téléchargement du modèle impossible (HTTP ${r.status})`);
  // content-length n'est fiable que sans compression de transfert.
  const declared = r.headers.get('content-encoding') ? 0 : +r.headers.get('content-length') || 0;
  const total = declared || m.size;
  const reader = r.body.getReader(), chunks = [];
  let loaded = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); loaded += value.length;
    if (loaded - last > 2_000_000) { last = loaded; post({ type: 'progress', loaded, total }); }
  }
  const buf = new Uint8Array(loaded);
  let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  chunks.length = 0;
  if (declared && loaded !== declared) throw new Error(`téléchargement du modèle incomplet (${loaded} / ${declared} octets)`);
  if (cache) {
    try { await cache.put(m.url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); }
    catch { /* quota dépassé : on continue sans cache */ }
  }
  return { bytes: buf, cache, fromCache: false };
}

async function load(name) {
  spec = MODELS[name];
  if (!spec) throw new Error('modèle inconnu : ' + name);
  const { bytes, cache, fromCache } = await fetchModel(spec);
  post({ type: 'status', text: 'Préparation du modèle…' });
  try { return await createSession(bytes); }
  catch (e) {
    // Un fichier en cache corrompu ferait échouer toutes les visites suivantes : on le purge.
    if (fromCache && cache) { try { await cache.delete(spec.url); } catch { /* rien à faire */ } }
    throw e;
  }
}

async function createSession(bytes) {
  const attempts = [];
  if ('gpu' in navigator) attempts.push('webgpu');
  attempts.push('wasm');
  let lastErr;
  for (const ep of attempts) {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'all' });
      const meta = session.inputMetadata?.[0];
      inputType = meta && /float16/.test(String(meta.type)) ? 'float16' : 'float32';
      // Certains GPU créent la session puis échouent à la première exécution (shader non pris
      // en charge) : on valide par un essai à vide avant de retenir ce backend.
      if (ep !== 'wasm') {
        post({ type: 'status', text: 'Vérification de l’accélération graphique…' });
        const probe = new Uint8ClampedArray(RES * RES * 4);
        for (let i = 0; i < probe.length; i += 4) { const v = (i >> 2) % RES; probe[i] = v; probe[i + 1] = 255 - (v >> 1); probe[i + 2] = 128; probe[i + 3] = 255; }
        const outp = await run(probe);
        // Certains pilotes renvoient des NaN en demi-précision : backend rejeté.
        for (let j = 0; j < outp.length; j += 997) if (!Number.isFinite(outp[j])) throw new Error('sortie WebGPU invalide (NaN)');
      }
      return ep;
    } catch (e) {
      lastErr = e;
      console.warn(`Backend ${ep} indisponible :`, e);
      try { await session?.release?.(); } catch { /* déjà libérée */ }
      session = null;
    }
  }
  throw lastErr;
}

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

async function run(pixels) {
  const N = RES * RES, f = new Float32Array(3 * N);
  for (let c = 0; c < 3; c++) {
    const m = MEAN[c], s = STD[c], off = c * N;
    for (let j = 0, i = c; j < N; j++, i += 4) f[off + j] = (pixels[i] / 255 - m) / s;
  }
  const tensor = inputType === 'float16'
    ? new ort.Tensor('float16', toHalf(f), [1, 3, RES, RES])
    : new ort.Tensor('float32', f, [1, 3, RES, RES]);
  const out = await session.run({ [session.inputNames[0]]: tensor });
  const t = out[session.outputNames[session.outputNames.length - 1]];
  let data = t.type === 'float16' ? fromHalf(t.data) : Float32Array.from(t.data);
  if (spec.logits) for (let j = 0; j < data.length; j++) data[j] = 1 / (1 + Math.exp(-data[j]));
  else for (let j = 0; j < data.length; j++) data[j] = data[j] < 0 ? 0 : data[j] > 1 ? 1 : data[j];
  t.dispose?.();
  return data;
}

// Conversion float32 ↔ float16 (IEEE 754 demi-précision), pour les modèles à entrée fp16.
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalf(src) {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    f32[0] = src[i]; const x = u32[0];
    const sign = (x >>> 16) & 0x8000, exp = ((x >>> 23) & 0xff) - 127 + 15, mant = x & 0x7fffff;
    if (exp <= 0) out[i] = sign; else if (exp >= 31) out[i] = sign | 0x7c00;
    else out[i] = sign | (exp << 10) | (mant >>> 13);
  }
  return out;
}
function fromHalf(src) {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const h = src[i], s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    out[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return out;
}

// Les messages de la phase de chargement portent l'identifiant du chargement en cours,
// pour que la page ignore ceux d'un chargement abandonné.
let loadId = null;
function post(msg, transfer) {
  if (loadId != null && msg.id == null && msg.type !== 'mask') msg.loadId = loadId;
  self.postMessage(msg, transfer || []);
}

let chain = Promise.resolve();
self.onmessage = e => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      if (msg.type === 'load') {
        loadId = msg.loadId ?? null;
        if (session) { await session.release?.(); session = null; }
        const backend = await load(msg.model);
        post({ type: 'ready', backend });
      } else if (msg.type === 'run') {
        if (!session) throw new Error("le modèle n'est pas chargé");
        const mask = await run(msg.pixels);
        post({ type: 'mask', id: msg.id, mask }, [mask.buffer]);
      }
    } catch (err) {
      post({ type: 'error', id: msg.id, message: String(err && err.message || err) });
    }
  });
};
