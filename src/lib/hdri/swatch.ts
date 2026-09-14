/** Preview swatches for the bundled-HDRI picker. Pure. */

import { linearToSrgb, softKnee } from './colorspace.ts';
import type { LinearImageF32 } from './types.ts';

/** Sky, horizon and ground stop, as `#rrggbb`. */
export type SwatchStops = [string, string, string];

/**
 * White point for the preview only. The swatch is a recognition aid, not a
 * colour-managed thumbnail, so a fixed modest knee beats deriving one per
 * image. That keeps a bright sky and a dim interior visually comparable.
 */
const PREVIEW_WHITE_POINT = 4;

function hex(r: number, g: number, b: number): string {
  const channel = (v: number) =>
    Math.round(linearToSrgb(softKnee(Math.max(0, v), PREVIEW_WHITE_POINT)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function meanBand(image: LinearImageF32, fromRow: number, toRow: number): [number, number, number] {
  const { data, width } = image;
  const start = Math.max(0, Math.min(image.height - 1, Math.floor(fromRow)));
  const end = Math.max(start + 1, Math.min(image.height, Math.ceil(toRow)));
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = start; y < end; y++) {
    let o = y * width * 3;
    for (let x = 0; x < width; x++, o += 3) {
      r += data[o];
      g += data[o + 1];
      b += data[o + 2];
    }
  }
  const count = (end - start) * width;
  return [r / count, g / count, b / count];
}

/**
 * Mean colour of the top 15 %, the equator band (+-10 %) and the bottom 15 %.
 * Rendered as a vertical CSS gradient this reads as an environment at a glance
 * and distinguishes a blue exterior from a warm studio from a sunset, with no
 * thumbnail file, no extra request and no decode on first paint.
 */
export function sampleSwatch(image: LinearImageF32): SwatchStops {
  const h = image.height;
  const sky = meanBand(image, 0, h * 0.15);
  const horizon = meanBand(image, h * 0.4, h * 0.6);
  const ground = meanBand(image, h * 0.85, h);
  return [hex(...sky), hex(...horizon), hex(...ground)];
}
