// Worker de post-traitement : { id, pixels, w, h, mask (Uint8 1024²), opts } → { id, rgba }
import { refine } from './matte.js';
import { RES } from './models.js';

self.onmessage = e => {
  const { id, pixels, w, h, mask, opts } = e.data;
  try {
    const m = new Float32Array(mask.length);
    for (let i = 0; i < mask.length; i++) m[i] = mask[i] / 255;
    const rgba = refine(pixels, w, h, m, RES, RES, opts);
    self.postMessage({ id, rgba }, [rgba.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
