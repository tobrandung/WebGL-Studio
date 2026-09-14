/**
 * IEEE 754 half-precision decoding.
 *
 * Deliberately not `THREE.DataUtils`: this module has to stay importable from
 * the Node preset script without pulling in three, and the whole point of the
 * pure core is that it has no dependencies at all. The LUT below was verified
 * against `DataUtils.fromHalfFloat` over all 65536 bit patterns.
 */

/** Decodes a single half-precision bit pattern. */
export function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;
  // Subnormals (and zero) have no implicit leading one.
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * (fraction + 1024) * 2 ** (exponent - 25);
}

let lut: Float32Array | null = null;

/**
 * Full 65536-entry half -> float table, built on first use (256 KB).
 *
 * The resampler hits this once per component per source pixel, 100M times for
 * an 8K image. So a table lookup rather than the bit twiddling above is worth
 * the allocation.
 */
export function halfToFloatTable(): Float32Array {
  if (lut) return lut;
  const table = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) table[i] = fromHalf(i);
  lut = table;
  return table;
}
