/**
 * Instant size projection, so the numbers move while a slider is being
 * dragged instead of only after the encoder has caught up.
 *
 * It is a residual model, not a global ratio: the JSON chunk passes through
 * untouched and is carried over verbatim, textures are projected per texture
 * from their own measured bits-per-pixel, and geometry from its vertex and
 * attribute counts. This gets roughly right what a global "expect 10×"
 * heuristic gets wrong: a model that is mostly geometry, or one whose
 * textures are already WebP.
 *
 * Honest error band: about ±15 % on the total for a model with several
 * textures, ±25 % on a single texture at quality ≥ 75 and ±40 % below 60.
 * Prune/dedup/weld savings are counted as zero because they are not
 * predictable at all.
 *
 * Measured against the real encoder on a 21 MB test model, the total came
 * out 9–14 % *below* the encoded size at default settings and 9 % above it
 * with Draco off. So the bias is not reliably in one direction, and the
 * number is labelled "≈" until the measurement replaces it rather than being
 * presented as a safe upper bound.
 */

import { gpuBytesFor, targetSize } from './image-fit.ts';
import { NORMAL_MAP_MIN_QUALITY, type OptimizeSettings, type SizeBreakdown, type SourceAnalysis } from './types.ts';

/**
 * Bits per pixel for WebP at a given quality, for an image of average
 * busyness. Measured anchors, log-linearly interpolated between.
 */
const WEBP_BPP: [quality: number, bpp: number][] = [
  [30, 0.16],
  [40, 0.22],
  [50, 0.28],
  [60, 0.36],
  [70, 0.47],
  [75, 0.55],
  [80, 0.66],
  [85, 0.83],
  [90, 1.15],
  [95, 1.75],
  [100, 2.6],
];

function webpBitsPerPixel(quality: number): number {
  const q = Math.max(30, Math.min(100, quality * 100));
  for (let i = 1; i < WEBP_BPP.length; i++) {
    const [q1, b1] = WEBP_BPP[i];
    if (q <= q1) {
      const [q0, b0] = WEBP_BPP[i - 1];
      const t = (q - q0) / (q1 - q0);
      // Interpolated in log space: bitrate grows geometrically with quality.
      return Math.exp(Math.log(b0) + t * (Math.log(b1) - Math.log(b0)));
    }
  }
  return WEBP_BPP[WEBP_BPP.length - 1][1];
}

/** Typical bits per pixel of a source container, used to gauge busyness. */
const SOURCE_ANCHOR: Record<string, number> = {
  'image/png': 8,
  'image/jpeg': 0.85,
  'image/webp': 0.55,
};

/**
 * How busy this particular image is, relative to a typical one in the same
 * format. This factor does most of the accuracy work. Without it a flat mask
 * and a photographic albedo get the same projection and both are wrong.
 */
function complexity(sizeBytes: number, width: number, height: number, mimeType: string): number {
  const pixels = width * height;
  const anchor = SOURCE_ANCHOR[mimeType];
  if (!pixels || !anchor) return 1;
  const sourceBpp = (sizeBytes * 8) / pixels;
  return Math.max(0.35, Math.min(2.5, sourceBpp / anchor));
}

/** Normal maps compress worse; packed ORM data compresses better. */
function slotFactor(slots: string[]): number {
  if (slots.includes('normalTexture')) return 1.6;
  if (slots.length > 0 && slots.every((slot) => /occlusion|metallicRoughness/i.test(slot))) {
    return 0.7;
  }
  return 1;
}

function estimateTextures(
  analysis: SourceAnalysis,
  settings: OptimizeSettings,
): { bytes: number; gpuBytes: number } {
  let bytes = 0;
  let gpuBytes = 0;

  for (const texture of analysis.textures) {
    const [width, height] = texture.width
      ? targetSize(texture.width, texture.height, settings.maxTextureSize)
      : [texture.width, texture.height];
    const pixels = width * height;
    gpuBytes += pixels ? gpuBytesFor(width, height) : texture.gpuSize;

    const shrank = pixels > 0 && pixels < texture.width * texture.height;

    if (settings.textureFormat === 'keep') {
      // Downscaling in the same format: bytes fall a little slower than pixel
      // count, because the detail that survives is concentrated.
      bytes += shrank
        ? texture.size * (pixels / (texture.width * texture.height)) ** 0.9
        : texture.size;
      continue;
    }

    if (!pixels) {
      bytes += texture.size;
      continue;
    }

    const quality = texture.slots.includes('normalTexture')
      ? Math.max(settings.textureQuality, NORMAL_MAP_MIN_QUALITY)
      : settings.textureQuality;

    const projected =
      (webpBitsPerPixel(quality) *
        complexity(texture.size, texture.width, texture.height, texture.mimeType) *
        slotFactor(texture.slots) *
        pixels) /
      8;

    // The pass keeps the original whenever re-encoding would grow it.
    bytes += Math.min(Math.max(512, projected), shrank ? Infinity : texture.size);
  }

  return { bytes: Math.round(bytes), gpuBytes };
}

/**
 * Draco output, per attribute rather than as a flat ratio. Quantisation bits
 * are glTF-Transform's defaults; the entropy coder lands around 60 % of the
 * raw quantised bit count, and edgebreaker connectivity costs roughly two
 * bits per triangle.
 */
const BYTES_PER_VERTEX: Record<string, number> = {
  POSITION: 3.2,
  NORMAL: 1.6,
  TEXCOORD_0: 1.95,
  TEXCOORD_1: 1.95,
  COLOR_0: 2.6,
  TANGENT: 2.6,
  JOINTS_0: 2,
  WEIGHTS_0: 2,
};

function estimateGeometry(analysis: SourceAnalysis, settings: OptimizeSettings): number {
  if (!settings.draco) return analysis.geometryBytes;
  // A source that is already Draco-compressed will not shrink further.
  if (analysis.sourceIsDraco) return analysis.geometryBytes;
  if (analysis.meshes.length === 0) return analysis.geometryBytes;

  let bytes = 0;
  for (const mesh of analysis.meshes) {
    const perVertex = mesh.attributes.reduce(
      (sum, attribute) => sum + (BYTES_PER_VERTEX[attribute] ?? 1.5),
      0,
    );
    bytes += perVertex * mesh.vertices + 0.28 * mesh.glPrimitives + 100 * mesh.primitives;
  }
  // Animation samplers are not touched by Draco, so whatever the container
  // holds beyond the meshes carries over.
  const untouched = Math.max(
    0,
    analysis.geometryBytes - analysis.meshes.reduce((sum, mesh) => sum + mesh.decodedSize, 0),
  );
  return Math.round(Math.min(analysis.geometryBytes, bytes + untouched));
}

export function estimateSize(analysis: SourceAnalysis, settings: OptimizeSettings): SizeBreakdown {
  const textures = estimateTextures(analysis, settings);
  const geometryBytes = estimateGeometry(analysis, settings);

  return {
    total: textures.bytes + geometryBytes + analysis.residualBytes,
    textureBytes: textures.bytes,
    geometryBytes,
    residualBytes: analysis.residualBytes,
    gpuBytes: textures.gpuBytes,
    measured: false,
  };
}
