/**
 * Shared types for the HDRI conversion pipeline.
 *
 * This module and its pure siblings, `half`, `colorspace`, `resample`, `rgbe`,
 * `exr-header`, `format`. Import nothing but each other, and only via explicit
 * `.ts` specifiers. That is what lets `scripts/convert-hdri.ts` run the very
 * same files under Node (whose native type stripping needs the extension and
 * knows nothing about Vite's `@` alias) while the app imports them through the
 * bundler. Anything that needs `three` or the DOM belongs in a sibling below
 * that line, not here.
 */

/** How a stored environment image has to be decoded. */
export type EnvironmentFormat = 'hdr' | 'exr' | 'ultrahdr' | 'sdr';

/**
 * Canonical decoded equirectangular image: row 0 is the north pole, exactly
 * three components per pixel, linear light.
 *
 * `HDRLoader` hands out top-down rows with `flipY = true`, `EXRLoader` bottom-up
 * rows with `flipY = false`. The decoders normalise to top-down before anything
 * else touches the data. Skip that and every EXR-sourced conversion comes out
 * vertically mirrored, which looks plausible in a studio HDRI and obviously
 * broken in a sky one.
 *
 * `data` stays a union because materialising an 8192x4096 source as Float32
 * costs 384 MB; the resampler converts half to float row by row instead.
 */
export type LinearImage = {
  data: Float32Array | Uint16Array;
  dataType: 'float32' | 'float16';
  width: number;
  height: number;
  /**
   * Components per pixel in `data`. The decoders hand back the loader's own
   * RGBA array (4) rather than copying it down to RGB, because that copy costs
   * 256 MB on an 8K source; `resample` is the one place that reads the big
   * array and it always outputs 3.
   */
  components: number;
  /** False for sources that never carried values above 1 (JPEG/PNG/WebP). */
  isHDR: boolean;
  /** Largest single component; drives the white point and `maxContentBoost`. */
  maxComponent: number;
};

/**
 * A `LinearImage` narrowed to what every encoder consumes: plain floats, three
 * interleaved components. This is what `resample` produces.
 */
export type LinearImageF32 = LinearImage & {
  data: Float32Array;
  dataType: 'float32';
  components: 3;
};

/** Stage of a conversion job, in the order they run. */
export type ConvertPhase = 'decode' | 'resample' | 'encode' | 'mux';

export type ConvertProgress = {
  phase: ConvertPhase;
  /** 0..1 over the whole job, monotonically non-decreasing. */
  progress: number;
  /** German label for the current stage, ready to render. */
  label: string;
};

/** Output formats the converter can produce. */
export type TargetFormat = 'hdr' | 'ultrahdr' | 'webp';

/**
 * One job: decode once, then encode every requested format at one resolution.
 * The decode is ~85 % of the wall time and the encoders are 50-600 ms, so
 * producing all three formats together makes the size comparison the UI shows
 * essentially free. A per-format job would pay for the decode three times.
 */
export type ConvertJob = {
  width: number;
  height: number;
  formats: readonly TargetFormat[];
  quality?: number;
};

/** One finished output. */
export type ConvertOutput = {
  format: TargetFormat;
  blob: Blob;
  fileName: string;
  width: number;
  height: number;
};

export type ConvertJobResult = {
  outputs: ConvertOutput[];
  source: { format: EnvironmentFormat; width: number; height: number; bytes: number };
};

export type ConvertWorkerRequest = {
  buffer: ArrayBuffer;
  fileName: string;
  format: EnvironmentFormat;
  job: ConvertJob;
  /** Refuse to decode beyond this many source pixels. */
  maxPixels: number;
};

export type ConvertWorkerResponse =
  | { type: 'progress'; progress: ConvertProgress }
  /** A finished, encoded file. */
  | {
      type: 'output';
      format: 'hdr' | 'webp';
      bytes: ArrayBuffer;
      mimeType: string;
      width: number;
      height: number;
    }
  /**
   * Resampled linear pixels for the Ultra HDR encoder, which needs a
   * WebGLRenderer and therefore has to finish on the main thread.
   */
  | {
      type: 'linear';
      data: ArrayBuffer;
      width: number;
      height: number;
      maxComponent: number;
    }
  | { type: 'complete'; source: { width: number; height: number } }
  | { type: 'error'; message: string };

/**
 * One bundled HDRI, as emitted by `scripts/convert-hdri.ts` into
 * `presets.generated.ts`. Byte sizes are exact so the picker can show real
 * numbers before it downloads anything.
 */
export type HdriPreset = {
  id: string;
  label: string;
  /** File name under `public/hdri/`, resolved against the app's base URL. */
  file: string;
  format: EnvironmentFormat;
  width: number;
  height: number;
  byteSize: number;
  /** Sky / horizon / ground colour for the picker's gradient swatch. */
  swatch: [string, string, string];
  /** Short character tag, e.g. 'Studio'. Absent when none could be inferred. */
  tag?: string;
  source: { fileName: string; width: number; height: number };
};
