// Modèles de détourage disponibles. Les fichiers sont téléchargés depuis Hugging Face
// une seule fois, puis conservés dans le cache du navigateur.

const HF = 'https://huggingface.co';

export const MODELS = {
  ben2: {
    label: 'Qualité max — BEN2 (219 Mo)',
    url: `${HF}/onnx-community/BEN2-ONNX/resolve/main/onnx/model_fp16.onnx`,
    size: 219_000_000,
    norm: 'imagenet',
    input: 'pixel_values',
  },
  birefnet: {
    label: 'Rapide — BiRefNet lite (115 Mo)',
    url: `${HF}/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx`,
    size: 115_000_000,
    norm: 'imagenet',
    input: 'input_image',
    logits: true, // sortie avant sigmoïde
  },
};

export const RES = 1024; // résolution d'entrée des deux modèles
