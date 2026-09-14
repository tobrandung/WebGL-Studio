/**
 * Streaming equirectangular box resampler. Pure. Shared byte-for-byte between
 * the in-app converter and the Node preset script.
 *
 * Exact area averaging, one destination row at a time. Two reasons for that
 * shape rather than the obvious alternatives:
 *
 * - **Quality.** A single bilinear pass (what `drawImage` would give you) samples
 *   4 of the 64 source pixels inside each output footprint when going 8K -> 1K
 *   and throws away 94 % of the energy. On a sky HDRI that shimmers; on a sun
 *   disc it randomly hits or misses, so the same source converted twice at
 *   slightly different sizes can differ by an EV in total irradiance.
 * - **Memory.** Materialising a `dstWidth x srcHeight` intermediate costs 96 MB
 *   for an 8K source. Working row by row needs `ceil(sy) + 2` cached lines,
 *   110 KB, and lets the half-to-float conversion fold into the horizontal
 *   pass, so a full-resolution Float32 copy never exists.
 *
 * The compute is not the bottleneck either way: 8K -> 1K measures ~96 ms against
 * ~2.6 s for the EXR decode that feeds it.
 */

import { halfToFloatTable } from './half.ts';
import type { LinearImage, LinearImageF32 } from './types.ts';

export type ResampleSource = Pick<
  LinearImage,
  'data' | 'dataType' | 'width' | 'height' | 'components'
>;

export type ResampleScratch = {
  slots: number;
  lineLength: number;
  lines: Float32Array;
  /** Which source row each ring slot currently holds, or -1. */
  rowIndex: Int32Array;
  accum: Float32Array;
  halfTable: Float32Array | null;
};

export function createScratch(
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): ResampleScratch {
  const lineLength = dstWidth * 3;
  // Destination rows are produced in order, so a ring of the vertical footprint
  // plus slack is enough for non-integer ratios to reuse overlapping rows.
  const slots = Math.max(2, Math.ceil(srcHeight / dstHeight) + 2);
  return {
    slots,
    lineLength,
    lines: new Float32Array(slots * lineLength),
    rowIndex: new Int32Array(slots).fill(-1),
    accum: new Float32Array(lineLength),
    halfTable: null,
  };
}

/** Area-averages one source row down to `dstWidth`, caching it in the ring. */
function horizontalLine(
  src: ResampleSource,
  dstWidth: number,
  srcY: number,
  scratch: ResampleScratch,
): Float32Array {
  const slot = srcY % scratch.slots;
  const line = scratch.lines.subarray(slot * scratch.lineLength, (slot + 1) * scratch.lineLength);
  if (scratch.rowIndex[slot] === srcY) return line;

  const { data, width, components } = src;
  const scale = width / dstWidth;
  const rowBase = srcY * width * components;
  // Single-channel sources (a luminance-only EXR) replicate into RGB.
  const offsetG = components > 1 ? 1 : 0;
  const offsetB = components > 2 ? 2 : 0;
  const table = src.dataType === 'float16' ? (scratch.halfTable ??= halfToFloatTable()) : null;

  for (let x = 0; x < dstWidth; x++) {
    const left = x * scale;
    const right = left + scale;
    const iEnd = Math.ceil(right);
    let r = 0;
    let g = 0;
    let b = 0;
    let weightSum = 0;
    for (let i = Math.floor(left); i < iEnd; i++) {
      const weight = Math.min(right, i + 1) - Math.max(left, i);
      if (weight <= 0) continue;
      // Equirect: wrap in X so the seam column averages against the opposite
      // edge instead of against nothing, which would leave a 1px vertical seam
      // in the background dome and a matching artefact in the PMREM.
      let ii = i % width;
      if (ii < 0) ii += width;
      const o = rowBase + ii * components;
      if (table) {
        r += table[data[o]] * weight;
        g += table[data[o + offsetG]] * weight;
        b += table[data[o + offsetB]] * weight;
      } else {
        r += data[o] * weight;
        g += data[o + offsetG] * weight;
        b += data[o + offsetB] * weight;
      }
      weightSum += weight;
    }
    const inv = weightSum > 0 ? 1 / weightSum : 0;
    const dst = x * 3;
    line[dst] = r * inv;
    line[dst + 1] = g * inv;
    line[dst + 2] = b * inv;
  }

  scratch.rowIndex[slot] = srcY;
  return line;
}

/**
 * Writes destination row `dstY` (3 interleaved floats per pixel) into `out` at
 * `outOffset`. `scratch` must come from `createScratch` for the same geometry
 * and be reused across rows. That reuse is what keeps overlapping source rows
 * from being resampled twice.
 */
export function resampleRow(
  src: ResampleSource,
  dstWidth: number,
  dstHeight: number,
  dstY: number,
  out: Float32Array,
  outOffset: number,
  scratch: ResampleScratch,
): void {
  const scale = src.height / dstHeight;
  const top = dstY * scale;
  const bottom = top + scale;
  // Clamp in Y: the poles must not wrap onto themselves.
  const jEnd = Math.min(src.height, Math.ceil(bottom));
  const { accum, lineLength } = scratch;
  accum.fill(0);
  let weightSum = 0;

  for (let j = Math.max(0, Math.floor(top)); j < jEnd; j++) {
    const weight = Math.min(bottom, j + 1) - Math.max(top, j);
    if (weight <= 0) continue;
    const line = horizontalLine(src, dstWidth, j, scratch);
    for (let k = 0; k < lineLength; k++) accum[k] += line[k] * weight;
    weightSum += weight;
  }

  const inv = weightSum > 0 ? 1 / weightSum : 0;
  for (let k = 0; k < lineLength; k++) out[outOffset + k] = accum[k] * inv;
}

export type ResampleOptions = {
  /** Called with 0..1 every few rows; also the place to check for cancellation. */
  onProgress?: (fraction: number) => void;
};

/**
 * Resamples a whole image to `dstWidth x dstHeight`, producing the canonical
 * 3-component float layout every encoder consumes. Also reports the peak
 * component of the *result*, which is what the white point and
 * `maxContentBoost` are derived from.
 */
export function resample(
  src: ResampleSource & Pick<LinearImage, 'isHDR'>,
  dstWidth: number,
  dstHeight: number,
  options: ResampleOptions = {},
): LinearImageF32 {
  if (dstWidth <= 0 || dstHeight <= 0) throw new Error('resample: empty target');
  const data = new Float32Array(dstWidth * dstHeight * 3);
  const scratch = createScratch(src.height, dstWidth, dstHeight);
  const step = Math.max(1, Math.floor(dstHeight / 64));

  for (let y = 0; y < dstHeight; y++) {
    resampleRow(src, dstWidth, dstHeight, y, data, y * dstWidth * 3, scratch);
    if (options.onProgress && (y % step === 0 || y === dstHeight - 1)) {
      options.onProgress((y + 1) / dstHeight);
    }
  }

  let maxComponent = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > maxComponent) maxComponent = data[i];
  }

  return {
    data,
    dataType: 'float32',
    components: 3,
    width: dstWidth,
    height: dstHeight,
    isHDR: src.isHDR,
    maxComponent,
  };
}
