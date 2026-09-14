/**
 * Tone maps a linear image into an SDR WebP. Browser-only (needs a canvas).
 *
 * The transfer is a soft knee in linear light, then the sRGB OETF. No ACES.
 * That choice matters and is not the obvious one: three disables tone mapping
 * for sRGB-tagged backgrounds (`WebGLBackground.js`:
 * `toneMapped = getTransfer(colorSpace) !== SRGBTransfer`), so a WebP dome is
 * drawn verbatim, while `scene.environment` gets no such exemption. Baking ACES
 * in would therefore be tone mapped a second time for every reflection and come
 * back crushed and desaturated. The knee keeps relative highlight structure at
 * the cost of absolute radiometry, which is the honest trade for a format that
 * cannot store values above 1 at all.
 */

import { estimateWhitePoint, linearToSrgb, softKnee } from './colorspace.ts';
import { canvasToBlob } from './decode-sdr.ts';
import type { LinearImageF32 } from './types.ts';

export type EncodeWebPOptions = {
  quality?: number;
  /** Override the automatic 99.9th-percentile white point. */
  whitePoint?: number;
  onProgress?: (fraction: number) => void;
};

export type WebPEncodeResult = { blob: Blob; whitePoint: number };

export async function encodeWebP(
  image: LinearImageF32,
  options: EncodeWebPOptions = {},
): Promise<WebPEncodeResult> {
  const { data, width, height } = image;
  const whitePoint = options.whitePoint ?? estimateWhitePoint(image);
  const pixels = width * height;
  const rgba = new Uint8ClampedArray(pixels * 4);

  // 256-entry ramp over the knee's output, which is smooth and monotonic, so
  // the per-pixel cost is one multiply plus a lookup instead of a Math.pow.
  const srgbRamp = new Uint8Array(4096);
  for (let i = 0; i < srgbRamp.length; i++) {
    srgbRamp[i] = Math.round(linearToSrgb(i / (srgbRamp.length - 1)) * 255);
  }

  const step = Math.max(1, Math.floor(height / 32));
  for (let y = 0; y < height; y++) {
    let src = y * width * 3;
    let dst = y * width * 4;
    for (let x = 0; x < width; x++, src += 3, dst += 4) {
      rgba[dst] = srgbRamp[(softKnee(Math.max(0, data[src]), whitePoint) * 4095) | 0];
      rgba[dst + 1] = srgbRamp[(softKnee(Math.max(0, data[src + 1]), whitePoint) * 4095) | 0];
      rgba[dst + 2] = srgbRamp[(softKnee(Math.max(0, data[src + 2]), whitePoint) * 4095) | 0];
      rgba[dst + 3] = 255;
    }
    if (y % step === 0) options.onProgress?.((y + 1) / height);
  }

  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  const context = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!context) throw new Error('encodeWebP: no 2d context');
  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  options.onProgress?.(1);

  return { blob: await canvasToBlob(canvas, 'image/webp', options.quality ?? 0.9), whitePoint };
}
