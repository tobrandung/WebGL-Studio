/**
 * Node-safe orchestration of the conversion: probe -> decode -> resample ->
 * Radiance. The browser worker builds on these same steps and adds the SDR
 * decode and the WebP encoder, which need a canvas.
 */

import { decodeHDR, type DecodeHDROptions } from './decode-hdr.ts';
import { probeEXR } from './exr-header.ts';
import { formatFromFileName, sniffEnvironmentFormat } from './format.ts';
import { resample } from './resample.ts';
import { encodeRGBE, probeRGBE } from './rgbe.ts';
import type { EnvironmentFormat, LinearImage, LinearImageF32 } from './types.ts';

export type ProbeInfo = {
  format: EnvironmentFormat;
  width: number;
  height: number;
  /** Set when the container uses a variant the decoder treats differently. */
  note?: string;
};

/**
 * Reads the dimensions out of the file header, decoding nothing.
 *
 * Returns null for SDR inputs, whose size only a real image decoder knows. The
 * browser path uses `createImageBitmap` for those. `head` only needs to cover
 * the header; 64 KB is plenty.
 */
export function probeEquirect(head: Uint8Array, fileName: string): ProbeInfo | null {
  const format = sniffEnvironmentFormat(head, fileName);
  if (format === 'exr') {
    const exr = probeEXR(head);
    return exr ? { format, width: exr.width, height: exr.height, note: exr.note } : null;
  }
  if (format === 'hdr') {
    const hdr = probeRGBE(head);
    return hdr ? { format, width: hdr.width, height: hdr.height } : null;
  }
  return null;
}

/** Equirectangular maps are 2:1; this keeps a target width honest. */
export function equirectHeightFor(width: number): number {
  return Math.max(1, Math.round(width / 2));
}

export type ConvertProgressPhase = 'decode' | 'resample' | 'encode';

export type PipelineOptions = DecodeHDROptions & {
  onProgress?: (phase: ConvertProgressPhase, fraction: number) => void;
  /** Extra `# …` comment lines for the Radiance header. */
  comments?: readonly string[];
};

export type RadianceConversion = {
  bytes: Uint8Array;
  image: LinearImageF32;
  source: { format: EnvironmentFormat; width: number; height: number; maxComponent: number };
};

/**
 * Decodes an `.exr`/`.hdr` buffer, resamples it and writes a Radiance file.
 * The decoded source array is released before the encoder runs, so peak memory
 * is the decode plus the (much smaller) target, never both targets at once.
 */
export async function convertToRadiance(
  buffer: ArrayBuffer,
  fileName: string,
  target: { width: number; height: number },
  options: PipelineOptions = {},
): Promise<RadianceConversion> {
  const format = formatFromFileName(fileName);
  if (format !== 'hdr' && format !== 'exr') {
    throw new Error(`convertToRadiance: ${format} inputs need the browser decoder`);
  }

  options.onProgress?.('decode', 0);
  const decoded: LinearImage = await decodeHDR(buffer, format, options);
  options.onProgress?.('decode', 1);

  const image = resample(decoded, target.width, target.height, {
    onProgress: (fraction) => options.onProgress?.('resample', fraction),
  });
  const source = {
    format,
    width: decoded.width,
    height: decoded.height,
    maxComponent: decoded.maxComponent,
  };

  options.onProgress?.('encode', 0);
  const bytes = encodeRGBE(image, { comments: options.comments });
  options.onProgress?.('encode', 1);

  return { bytes, image, source };
}
