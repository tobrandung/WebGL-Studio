/**
 * Encodes a linear image as an Ultra HDR JPEG: an ordinary JPEG carrying an HDR
 * gain map in its MPF container, which three's `UltraHDRLoader` reconstructs
 * back to linear HDR data.
 *
 * This is the smallest format that keeps real highlight range. Roughly 0.5-0.9
 * MB at 2048x1024 against 5.4 MB for the equivalent Radiance file. And it
 * degrades to its plain SDR base in any decoder that does not know about gain
 * maps.
 *
 * Main thread only: the encode runs GPU passes through a `WebGLRenderer`.
 */

import * as THREE from 'three';
import { encodeAndCompress, findTextureMinMax } from '@monogrid/gainmap-js/encode';
import { encodeJPEGMetadata } from '@monogrid/gainmap-js/libultrahdr';
import type { LinearImageF32 } from './types.ts';

export type EncodeUltraHDROptions = {
  /**
   * Renderer to encode with. Omitted by default so the library creates and
   * disposes its own: sharing the editor's renderer risks leaving a render
   * target bound and corrupting the next viewport frame.
   */
  renderer?: THREE.WebGLRenderer;
  quality?: number;
  onProgress?: (fraction: number) => void;
};

/** Builds the RGBA float `DataTexture` the encoder expects. */
function toDataTexture(image: LinearImageF32): THREE.DataTexture {
  const { width, height, data } = image;
  // RGBA is mandatory. Three removed RGBFormat in r137.
  const rgba = new Float32Array(width * height * 4);
  for (let p = 0, src = 0, dst = 0; p < width * height; p++, src += 3, dst += 4) {
    rgba[dst] = data[src];
    rgba[dst + 1] = data[src + 1];
    rgba[dst + 2] = data[src + 2];
    rgba[dst + 3] = 1;
  }
  const texture = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  // Canonical rows are top-down, matching what HDRLoader produces; `flipY` is
  // what turns that into the orientation the GPU passes expect.
  texture.flipY = true;
  texture.needsUpdate = true;
  return texture;
}

export async function encodeUltraHDR(
  image: LinearImageF32,
  options: EncodeUltraHDROptions = {},
): Promise<Blob> {
  const texture = toDataTexture(image);
  options.onProgress?.(0.15);
  try {
    // Encoding the full range: the boost ceiling is the actual peak, so nothing
    // is thrown away that the gain map could have carried.
    const peak = Math.max(...findTextureMinMax(texture), 1.0001);
    const result = await encodeAndCompress({
      image: texture,
      maxContentBoost: peak,
      mimeType: 'image/jpeg',
      quality: options.quality ?? 0.9,
      // The RAW GPU readback is bottom-up; this is what makes the JPEG top-down.
      flipY: true,
      renderer: options.renderer,
    });
    options.onProgress?.(0.8);

    // Pure JS in 3.4.0 (no WASM, no async init): muxes the SDR base, the gain
    // map and the XMP/MPF metadata into one file.
    const jpeg = encodeJPEGMetadata({ ...result, sdr: result.sdr, gainMap: result.gainMap });
    options.onProgress?.(1);
    return new Blob([jpeg as BlobPart], { type: 'image/jpeg' });
  } finally {
    texture.dispose();
  }
}
