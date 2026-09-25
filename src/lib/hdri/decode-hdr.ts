/**
 * Decodes `.exr` and `.hdr` into the canonical `LinearImage`. Runs unchanged in
 * the browser, in a Web Worker and in Node, `parse()` on three's data-texture
 * loaders is a pure function over an ArrayBuffer with no DOM access.
 */

import { FloatType, HalfFloatType, RedFormat, RGFormat } from 'three';
import { fromHalf } from './half.ts';
import type { LinearImage } from './types.ts';

/**
 * Up to this many pixels the decode uses Float32 (4096x2048 -> 128 MB), above it
 * half-float (which halves the footprint and clips at 65504. Measured at 0.93 %
 * of total irradiance on the worst of the sample HDRIs, a bare sun disc).
 */
export const FLOAT_DECODE_PIXEL_LIMIT = 8_400_000;

/**
 * Hard ceiling for decoding in a browser tab. An 8192x4096 half-float RGBA
 * array is 256 MB before anything else happens; beyond that the tab dies on
 * mobile and stalls on the desktop, so the UI points at the CLI instead.
 */
export const MAX_DECODE_PIXELS = 33_600_000;

function componentsOf(format: unknown): number {
  if (format === RedFormat) return 1;
  if (format === RGFormat) return 2;
  return 4;
}

/**
 * Mirrors the rows in place. `EXRLoader` emits bottom-up rows (and sets
 * `flipY = false`), `HDRLoader` top-down ones. Everything downstream assumes
 * top-down; without this every EXR-sourced conversion comes out mirrored, which
 * looks plausible in a studio HDRI and obviously wrong in a sky one.
 */
function flipRowsInPlace(data: Float32Array | Uint16Array, stride: number, height: number): void {
  const half = height >> 1;
  if (data instanceof Float32Array) {
    const temp = new Float32Array(stride);
    for (let y = 0; y < half; y++) {
      const top = y * stride;
      const bottom = (height - 1 - y) * stride;
      temp.set(data.subarray(top, top + stride));
      data.copyWithin(top, bottom, bottom + stride);
      data.set(temp, bottom);
    }
  } else {
    const temp = new Uint16Array(stride);
    for (let y = 0; y < half; y++) {
      const top = y * stride;
      const bottom = (height - 1 - y) * stride;
      temp.set(data.subarray(top, top + stride));
      data.copyWithin(top, bottom, bottom + stride);
      data.set(temp, bottom);
    }
  }
}

/** Peak of the first three components, ignoring alpha, negatives and NaN. */
function peakComponent(
  data: Float32Array | Uint16Array,
  dataType: 'float32' | 'float16',
  pixels: number,
  components: number,
): number {
  const channels = Math.min(3, components);
  if (dataType === 'float16') {
    // Positive finite half-floats order monotonically as unsigned integers, so
    // the peak is an integer max plus one decode. Values at or above 0x7c00 are
    // Inf/NaN and anything with the sign bit set is negative; both are skipped.
    let bits = 0;
    for (let p = 0, o = 0; p < pixels; p++, o += components) {
      for (let c = 0; c < channels; c++) {
        const v = data[o + c];
        if (v < 0x7c00 && v > bits) bits = v;
      }
    }
    return fromHalf(bits);
  }
  let max = 0;
  for (let p = 0, o = 0; p < pixels; p++, o += components) {
    for (let c = 0; c < channels; c++) {
      if (data[o + c] > max) max = data[o + c];
    }
  }
  return max;
}

/**
 * `DataUtils.toHalfFloat` warns once per out-of-range component. A sun-disc EXR
 * produces dozens and a badly clipped one could produce thousands, which locks
 * up devtools; they are counted instead of printed.
 */
function withoutHalfFloatWarnings<T>(run: () => T): { value: T; suppressed: number } {
  const original = console.warn;
  let suppressed = 0;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('toHalfFloat')) {
      suppressed++;
      return;
    }
    original.apply(console, args as []);
  };
  try {
    return { value: run(), suppressed };
  } finally {
    console.warn = original;
  }
}

export type DecodeHDROptions = {
  /**
   * Force full float precision. Defaults to whatever `FLOAT_DECODE_PIXEL_LIMIT`
   * allows; the CLI sets it unconditionally because memory is free there and it
   * is the only way to keep a sun disc above 65504.
   */
  preferFloat32?: boolean;
};

/** Decodes a Radiance or OpenEXR buffer into a top-down linear image. */
export async function decodeHDR(
  buffer: ArrayBuffer,
  format: 'hdr' | 'exr',
  options: DecodeHDROptions = {},
): Promise<LinearImage> {
  // Precision has to be chosen before parsing, so the pixel count is estimated
  // from the buffer: even the densest float EXR carries at least ~2 bytes per
  // pixel, which makes this an upper bound rather than a guess that can go low.
  const guessedPixels = buffer.byteLength / 2;
  const type = (options.preferFloat32 ?? guessedPixels <= FLOAT_DECODE_PIXEL_LIMIT)
    ? FloatType
    : HalfFloatType;

  let data: Float32Array | Uint16Array;
  let width: number;
  let height: number;
  let components: number;

  if (format === 'exr') {
    const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js');
    const loader = new EXRLoader().setDataType(type);
    const { value: exr } = withoutHalfFloatWarnings(() => loader.parse(buffer));
    // Optional in the r186 types; validated right after this branch.
    width = exr.width ?? 0;
    height = exr.height ?? 0;
    // Channel count varies: a luminance-only EXR comes back as RedFormat.
    components = componentsOf(exr.format);
    data = exr.data as Float32Array | Uint16Array;
    flipRowsInPlace(data, width * components, height);
  } else {
    // HDRLoader, not RGBELoader: the latter is a deprecation shim in r180+ that
    // logs a warning on every construction.
    const { HDRLoader } = await import('three/addons/loaders/HDRLoader.js');
    const loader = new HDRLoader().setDataType(type);
    const { value: hdr } = withoutHalfFloatWarnings(() => loader.parse(buffer));
    width = hdr.width ?? 0;
    height = hdr.height ?? 0;
    components = 4;
    // Rows are already top-down. The bundled types say `Uint8Array` for the
    // half-float path; the loader actually returns a Uint16Array.
    data = hdr.data as Float32Array | Uint16Array;
  }

  if (!width || !height) throw new Error('decodeHDR: loader returned no dimensions');
  if (!(data instanceof Float32Array) && !(data instanceof Uint16Array)) {
    throw new Error('decodeHDR: unexpected pixel array type');
  }

  const dataType = data instanceof Float32Array ? 'float32' : 'float16';
  return {
    data,
    dataType,
    components,
    width,
    height,
    isHDR: true,
    maxComponent: peakComponent(data, dataType, width * height, components),
  };
}
