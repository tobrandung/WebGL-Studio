/**
 * The half of `convert-hdri.ts` that cannot run in Node.
 *
 * Decoding and resampling are pure arithmetic and stay on the CLI side. The
 * Ultra HDR encoder is not: it runs its gain-map passes through a
 * `WebGLRenderer`, and the WebP encoder needs a canvas. So the CLI starts a
 * Vite dev server, drives a headless Chrome onto this page and calls the
 * function below once per preset.
 *
 * The encoders themselves are the app's own, imported unchanged, so a preset
 * and a file a user converts in the upload dialog come out of the same code.
 */

import { encodeUltraHDR } from '../src/lib/hdri/encode-ultrahdr.ts';
import { encodeWebP } from '../src/lib/hdri/encode-webp.ts';
import type { LinearImageF32 } from '../src/lib/hdri/types.ts';

type EncodeRequest = {
  /** Dev-server path of the raw Float32 RGB dump the CLI wrote. */
  url: string;
  width: number;
  height: number;
  /** Brightest component in the dump, carried over rather than re-scanned. */
  maxComponent: number;
  format: 'ultrahdr' | 'webp';
  quality?: number;
};

async function toBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit somewhere
  // around a megabyte, which every 2K encode exceeds.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function encode(request: EncodeRequest): Promise<{ base64: string; byteSize: number }> {
  const response = await fetch(request.url);
  if (!response.ok) throw new Error(`fetch ${request.url}: HTTP ${response.status}`);
  const data = new Float32Array(await response.arrayBuffer());

  const expected = request.width * request.height * 3;
  if (data.length !== expected) {
    throw new Error(`expected ${expected} floats, got ${data.length}`);
  }

  const image: LinearImageF32 = {
    data,
    dataType: 'float32',
    components: 3,
    isHDR: true,
    maxComponent: request.maxComponent,
    width: request.width,
    height: request.height,
  };
  const blob =
    request.format === 'ultrahdr'
      ? await encodeUltraHDR(image, { quality: request.quality })
      : (await encodeWebP(image, { quality: request.quality })).blob;

  return { base64: await toBase64(blob), byteSize: blob.size };
}

declare global {
  interface Window {
    encodeHdriPreset: (request: EncodeRequest) => Promise<{ base64: string; byteSize: number }>;
    hdriEncoderReady: true;
  }
}

window.encodeHdriPreset = encode;
window.hdriEncoderReady = true;
