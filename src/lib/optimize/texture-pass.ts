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
import { gpuBytesFor, readImageSize, targetSize } from './image-fit.ts';
import { NORMAL_MAP_MIN_QUALITY, type OptimizeSettings } from './types.ts';

/** Containers `createImageBitmap` can decode. KTX2/Basis is not one of them. */
const DECODABLE = ['image/png', 'image/jpeg', 'image/webp'];

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
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

/**
 * Keeps the decoded-and-resized canvas for each texture, so moving the
 * quality slider costs one `convertToBlob` per texture instead of a full
 * decode and redraw. That is the difference between a slider that responds
 * and one that stutters.
 *
 * Capped by backing-store bytes rather than entry count, because a 2048²
 * canvas is 16 MB and a 512² one is 1 MB — an entry count would either starve
 * the small case or blow up memory in the large one. Least-recently-used
 * entries are dropped first.
 */
const CANVAS_CACHE_BYTES = 48 * 1024 * 1024;

class ResizedCanvasCache {
  private entries = new Map<string, { canvas: AnyCanvas; bytes: number }>();
  private total = 0;

  get(key: string): AnyCanvas | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Re-insert so Map iteration order stays least-recently-used first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.canvas;
  }

  set(key: string, canvas: AnyCanvas): void {
    const bytes = canvas.width * canvas.height * 4;
    if (bytes > CANVAS_CACHE_BYTES) return;
    this.entries.set(key, { canvas, bytes });
    this.total += bytes;
    for (const [oldest, entry] of this.entries) {
      if (this.total <= CANVAS_CACHE_BYTES) break;
      if (oldest === key) continue;
      this.entries.delete(oldest);
      this.total -= entry.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}

async function resizedCanvas(
  original: TextureOriginal,
  width: number,
  height: number,
): Promise<AnyCanvas> {
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
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d', { colorSpace: 'srgb' }) as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!context) throw new Error('texture-pass: kein 2D-Kontext');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/** Header-only size read, so choosing a target never costs a decode. */
function sourceSize(original: TextureOriginal): [number, number] | null {
  return readImageSize(original.image, original.mimeType);
}

async function encodeTexture(
  original: TextureOriginal,
  index: number,
  options: TexturePassOptions,
  cache: ResizedCanvasCache,
): Promise<{ image: Uint8Array; mimeType: string; width: number; height: number } | null> {
  const source = sourceSize(original);
  const targetMime = options.textureFormat === 'webp' ? 'image/webp' : original.mimeType;

  const [width, height] = source
    ? targetSize(source[0], source[1], options.maxTextureSize)
    : [0, 0];
  const sameSize = !source || (width === source[0] && height === source[1]);
  if (sameSize && targetMime === original.mimeType) return null;

  const key = `${index}:${width}x${height}`;
  let canvas = cache.get(key);
  if (!canvas) {
    canvas = await resizedCanvas(original, width, height);
    cache.set(key, canvas);
  }

  const quality = qualityForSlots(original.slots, options.textureQuality);
  const encoded = await canvasToBlob(canvas, targetMime, quality);
  const image = new Uint8Array(await encoded.arrayBuffer());

  // A flat or already-small image can come out bigger than it went in.
  // Growing a file during "optimise" is never the right answer.
  if (image.byteLength >= original.image.byteLength && targetMime === original.mimeType) {
    return null;
  }

  return { image, mimeType: targetMime, width, height };
}

/** Reusable across runs, so the cache survives a settings change. */
export function createTextureCache(): ResizedCanvasCache {
  return new ResizedCanvasCache();
}

export type { ResizedCanvasCache };

/**
 * Rewrites every decodable texture in place, always starting from `originals`.
 * Safe to call repeatedly on the same Document with different settings.
 */
export async function runTexturePass(
  document: Document,
  originals: TextureOriginal[],
  options: TexturePassOptions,
  cache: ResizedCanvasCache = new ResizedCanvasCache(),
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
        const encoded = await encodeTexture(original, index, options, cache);
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

