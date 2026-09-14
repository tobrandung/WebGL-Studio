/**
 * Decodes JPEG/PNG/WebP into the canonical linear image. Browser-only, because
 * `createImageBitmap` and a canvas do the actual decoding.
 */

import { SRGB_TO_LINEAR } from './colorspace.ts';
import type { LinearImageF32 } from './types.ts';

/**
 * iOS Safari caps total canvas area at roughly 16.7 Mpx (and older iOS at
 * 4096x4096). An oversized canvas does not throw. It returns blank pixels, so
 * the environment silently comes out black. Reading in strips of at most this
 * many pixels is safe everywhere and doubles as the progress granularity.
 */
const STRIP_PIXELS = 4_000_000;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Encodes a canvas to a Blob across both canvas flavours. */
export async function canvasToBlob(canvas: AnyCanvas, type: string, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new Error(`canvasToBlob: ${type} encoding failed`);
  return blob;
}

export type DecodeSDROptions = {
  onProgress?: (fraction: number) => void;
};

export async function decodeSDR(blob: Blob, options: DecodeSDROptions = {}): Promise<LinearImageF32> {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  try {
    const stripHeight = Math.max(1, Math.floor(STRIP_PIXELS / width));
    const canvas = createCanvas(width, Math.min(stripHeight, height));
    const context = canvas.getContext('2d', { willReadFrequently: true }) as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!context) throw new Error('decodeSDR: no 2d context');

    const data = new Float32Array(width * height * 3);
    let maxComponent = 0;

    for (let y = 0; y < height; y += stripHeight) {
      const rows = Math.min(stripHeight, height - y);
      context.clearRect(0, 0, width, rows);
      context.drawImage(bitmap, 0, y, width, rows, 0, 0, width, rows);
      const strip = context.getImageData(0, 0, width, rows).data;
      let out = y * width * 3;
      for (let i = 0; i < rows * width * 4; i += 4, out += 3) {
        const r = SRGB_TO_LINEAR[strip[i]];
        const g = SRGB_TO_LINEAR[strip[i + 1]];
        const b = SRGB_TO_LINEAR[strip[i + 2]];
        data[out] = r;
        data[out + 1] = g;
        data[out + 2] = b;
        if (r > maxComponent) maxComponent = r;
        if (g > maxComponent) maxComponent = g;
        if (b > maxComponent) maxComponent = b;
      }
      options.onProgress?.(Math.min(1, (y + rows) / height));
    }

    return { data, dataType: 'float32', components: 3, width, height, isHDR: false, maxComponent };
  } finally {
    // A 33 Mpx bitmap holds ~134 MB; closing it is not optional.
    bitmap.close();
  }
}

/** Reads just the dimensions of an SDR image. */
export async function probeSDR(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}
