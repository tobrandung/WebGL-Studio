/**
 * Re-encodes a Document's textures with the browser's own image pipeline.
 *
 * Deliberately not `textureCompress()` from @gltf-transform/functions: without
 * a Sharp encoder — Node-only — it falls back to ndarray-pixels and, in its own
 * words, "most quality- and compression-related options are ignored". The
 * quality slider would do nothing. `createImageBitmap` + canvas honours it and
 * is hardware-accelerated on top.
 *
 * The pass always encodes from a captured copy of the *original* images, never
 * from whatever is currently on the Document. Running it twice — which is
 * exactly what a quality slider does — would otherwise compress an already
 * compressed image, and the damage would accumulate with every drag.
 */

import type { Document, Texture } from '@gltf-transform/core';
import { EXTTextureWebP } from '@gltf-transform/extensions';
import { listTextureSlots } from '@gltf-transform/functions';
import { canvasToBlob } from '@/lib/hdri/decode-sdr';
import { NORMAL_MAP_MIN_QUALITY, type OptimizeSettings } from './types.ts';

/** Containers `createImageBitmap` can decode. KTX2/Basis is not one of them. */
const DECODABLE = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * iOS Safari silently returns blank pixels above roughly 16.7 Mpx of canvas
 * area rather than throwing, so a 4096² texture sits exactly on the edge.
 * Staying below keeps the pass from producing invisible textures on iPads
 * with no error to go on.
 */
const MAX_CANVAS_PIXELS = 16_000_000;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

/**
 * Target size for one texture: never upscale, always keep the aspect ratio,
 * and keep a power-of-two source power-of-two by halving rather than fitting.
 * NPOT is legal on WebGL2, but its mipmaps are more expensive and blurrier, so
 * a 2048² texture should land on 1024², not on some fitted odd number.
 */
export function targetSize(width: number, height: number, max: number): [number, number] {
  if (width <= max && height <= max && width * height <= MAX_CANVAS_PIXELS) {
    return [width, height];
  }

  if (isPowerOfTwo(width) && isPowerOfTwo(height)) {
    let w = width;
    let h = height;
    while ((w > max || h > max || w * h > MAX_CANVAS_PIXELS) && w > 1 && h > 1) {
      w /= 2;
      h /= 2;
    }
    return [w, h];
  }

  const scale = Math.min(max / width, max / height, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/**
 * Normal maps store direction vectors, not colour. Lossy compression bends
 * them and the error surfaces as banding in the specular highlight, which
 * reads as a broken material rather than a soft image — so they keep their own
 * floor no matter where the slider sits.
 */
function qualityForSlots(slots: string[], base: number): number {
  if (slots.includes('normalTexture')) return Math.max(base, NORMAL_MAP_MIN_QUALITY);
  return base;
}

/** An untouched source image, kept so repeated passes never stack losses. */
export type TextureOriginal = {
  image: Uint8Array;
  mimeType: string;
  slots: string[];
  name: string;
};

/** Snapshot the images as they are now. Call once, after cleaning. */
export function captureTextureOriginals(document: Document): TextureOriginal[] {
  return document
    .getRoot()
    .listTextures()
    .map((texture, index) => ({
      image: texture.getImage() ?? new Uint8Array(),
      mimeType: texture.getMimeType(),
      slots: listTextureSlots(texture),
      name: texture.getName() || texture.getURI() || `Textur ${index + 1}`,
    }));
}

export type TexturePassOptions = Pick<
  OptimizeSettings,
  'textureFormat' | 'maxTextureSize' | 'textureQuality'
> & {
  onProgress?: (done: number, total: number) => void;
};

export type TexturePassResult = {
  /** Bytes of every texture in the document after the pass. */
  textureBytes: number;
  /** Decoded RGBA bytes incl. mipmaps after the pass. */
  gpuBytes: number;
  /** Textures left untouched, with the reason. */
  skipped: { name: string; reason: string }[];
};

async function encodeTexture(
  original: TextureOriginal,
  options: TexturePassOptions,
): Promise<{ image: Uint8Array; mimeType: string; width: number; height: number } | null> {
  const blob = new Blob([original.image as BlobPart], { type: original.mimeType });
  // Both flags matter and both default the wrong way for texture data:
  // premultiplication folds alpha into RGB (ruining packed and cut-out maps)
  // and colour-space conversion applies any embedded ICC profile, shifting
  // every colour. The glTF material decides the colour space, not the file.
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });

  try {
    const [width, height] = targetSize(bitmap.width, bitmap.height, options.maxTextureSize);
    const targetMime = options.textureFormat === 'webp' ? 'image/webp' : original.mimeType;
    const sameSize = width === bitmap.width && height === bitmap.height;
    if (sameSize && targetMime === original.mimeType) return null;

    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d', { colorSpace: 'srgb' }) as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!context) throw new Error('texture-pass: kein 2D-Kontext');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);

    const quality = qualityForSlots(original.slots, options.textureQuality);
    const encoded = await canvasToBlob(canvas, targetMime, quality);
    const image = new Uint8Array(await encoded.arrayBuffer());

    // A flat or already-small image can come out bigger than it went in.
    // Growing a file during "optimise" is never the right answer.
    if (image.byteLength >= original.image.byteLength && targetMime === original.mimeType) {
      return null;
    }

    return { image, mimeType: targetMime, width, height };
  } finally {
    bitmap.close();
  }
}

/** Decoded RGBA bytes a texture occupies on the GPU, mipmaps included. */
function gpuBytesFor(width: number, height: number): number {
  return Math.round(width * height * 4 * (4 / 3));
}

/**
 * Rewrites every decodable texture in place, always starting from `originals`.
 * Safe to call repeatedly on the same Document with different settings.
 */
export async function runTexturePass(
  document: Document,
  originals: TextureOriginal[],
  options: TexturePassOptions,
): Promise<TexturePassResult> {
  const textures = document.getRoot().listTextures();
  const skipped: TexturePassResult['skipped'] = [];
  let gpuBytes = 0;

  for (const [index, texture] of textures.entries()) {
    const original = originals[index];
    if (!original) continue;

    if (!DECODABLE.includes(original.mimeType)) {
      skipped.push({
        name: original.name,
        reason: `${original.mimeType} kann der Browser nicht decodieren`,
      });
      restore(texture, original);
    } else {
      try {
        const encoded = await encodeTexture(original, options);
        if (encoded) {
          texture.setImage(encoded.image).setMimeType(encoded.mimeType);
          const uri = texture.getURI();
          if (uri && encoded.mimeType === 'image/webp') {
            texture.setURI(uri.replace(/\.\w+$/, '.webp'));
          }
          gpuBytes += gpuBytesFor(encoded.width, encoded.height);
        } else {
          restore(texture, original);
          gpuBytes += gpuBytesFromImage(original);
        }
      } catch (error) {
        skipped.push({
          name: original.name,
          reason: error instanceof Error ? error.message : 'Encoding fehlgeschlagen',
        });
        restore(texture, original);
        gpuBytes += gpuBytesFromImage(original);
      }
    }

    options.onProgress?.(index + 1, textures.length);
  }

  // EXT_texture_webp goes into extensionsRequired, so it may only be declared
  // when a WebP texture actually survived the pass.
  const existing = document
    .getRoot()
    .listExtensionsUsed()
    .find((extension) => extension.extensionName === EXTTextureWebP.EXTENSION_NAME);
  const needsWebP = textures.some((texture) => texture.getMimeType() === 'image/webp');
  if (needsWebP && !existing) {
    document.createExtension(EXTTextureWebP).setRequired(true);
  } else if (!needsWebP && existing) {
    existing.dispose();
  }

  const textureBytes = textures.reduce(
    (total, texture) => total + (texture.getImage()?.byteLength ?? 0),
    0,
  );

  return { textureBytes, gpuBytes, skipped };
}

/** Puts a texture back to its captured source, undoing an earlier pass. */
function restore(texture: Texture, original: TextureOriginal): void {
  if (texture.getMimeType() !== original.mimeType || texture.getImage() !== original.image) {
    texture.setImage(original.image).setMimeType(original.mimeType);
  }
}

/**
 * GPU cost of an original we did not decode this run. Dimensions come from the
 * container header rather than a full decode, which would be wasteful here.
 */
function gpuBytesFromImage(original: TextureOriginal): number {
  const size = readImageSize(original.image, original.mimeType);
  return size ? gpuBytesFor(size[0], size[1]) : 0;
}

/** Minimal PNG/JPEG/WebP header parse — dimensions only. */
export function readImageSize(bytes: Uint8Array, mimeType: string): [number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mimeType === 'image/png') {
      return [view.getUint32(16, false), view.getUint32(20, false)];
    }
    if (mimeType === 'image/jpeg') {
      let offset = 2;
      while (offset < bytes.byteLength) {
        if (view.getUint8(offset) !== 0xff) break;
        const marker = view.getUint8(offset + 1);
        const length = view.getUint16(offset + 2, false);
        // SOF0-SOF15, excluding the DHT/DAC/RST markers in that range.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return [view.getUint16(offset + 7, false), view.getUint16(offset + 5, false)];
        }
        offset += 2 + length;
      }
      return null;
    }
    if (mimeType === 'image/webp') {
      // VP8X carries the canvas size as two 24-bit values, minus one.
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === 'VP8X') {
        const w = (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16)) + 1;
        const h = (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16)) + 1;
        return [w, h];
      }
      if (chunk === 'VP8 ') {
        return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}
