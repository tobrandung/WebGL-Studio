/**
 * Re-encodes a Document's textures with the browser's own image pipeline.
 *
 * Deliberately not `textureCompress()` from @gltf-transform/functions: without
 * a Sharp encoder — Node-only — it falls back to ndarray-pixels and, in its own
 * words, "most quality- and compression-related options are ignored". The
 * quality slider would do nothing. `createImageBitmap` + canvas honours it and
 * is hardware-accelerated on top.
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
 * Staying one step below keeps the pass from producing invisible textures on
 * iPads without any error to go on.
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

/** Slots whose contents are direction vectors or packed channels, not colour. */
function qualityForSlots(slots: string[], base: number): number {
  if (slots.includes('normalTexture')) return Math.max(base, NORMAL_MAP_MIN_QUALITY);
  return base;
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
  /** Textures that were left untouched, with the reason. */
  skipped: { name: string; reason: string }[];
};

async function encodeTexture(
  texture: Texture,
  options: TexturePassOptions,
): Promise<{ image: Uint8Array; mimeType: string } | null> {
  const source = texture.getImage();
  const sourceMime = texture.getMimeType();
  if (!source) return null;

  const blob = new Blob([source as BlobPart], { type: sourceMime });
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
    const targetMime = options.textureFormat === 'webp' ? 'image/webp' : sourceMime;
    const unchanged = width === bitmap.width && height === bitmap.height;
    if (unchanged && targetMime === sourceMime) return null;

    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d', { colorSpace: 'srgb' }) as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!context) throw new Error('texture-pass: no 2d context');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);

    const quality = qualityForSlots(listTextureSlots(texture), options.textureQuality);
    const encoded = await canvasToBlob(canvas, targetMime, quality);
    const image = new Uint8Array(await encoded.arrayBuffer());

    // A flat or already-small image can come out bigger than it went in.
    // Growing a file during "optimise" is never the right answer.
    if (image.byteLength >= source.byteLength && targetMime === sourceMime) return null;

    return { image, mimeType: targetMime };
  } finally {
    bitmap.close();
  }
}

/**
 * Rewrites every decodable texture in place. `texture.setImage()` is
 * idempotent, so this can run repeatedly on the same Document — which is what
 * makes the live quality slider affordable.
 */
export async function runTexturePass(
  document: Document,
  options: TexturePassOptions,
): Promise<TexturePassResult> {
  const textures = document.getRoot().listTextures();
  const skipped: TexturePassResult['skipped'] = [];
  let done = 0;

  for (const texture of textures) {
    const name = texture.getName() || texture.getURI() || `Textur ${done + 1}`;
    const mimeType = texture.getMimeType();

    if (!DECODABLE.includes(mimeType)) {
      skipped.push({ name, reason: `Format ${mimeType} kann der Browser nicht decodieren` });
    } else {
      try {
        const encoded = await encodeTexture(texture, options);
        if (encoded) {
          texture.setImage(encoded.image);
          if (encoded.mimeType !== mimeType) {
            const uri = texture.getURI();
            texture.setMimeType(encoded.mimeType);
            if (uri) texture.setURI(uri.replace(/\.\w+$/, '.webp'));
          }
        }
      } catch (error) {
        skipped.push({ name, reason: error instanceof Error ? error.message : 'Encoding fehlgeschlagen' });
      }
    }

    done += 1;
    options.onProgress?.(done, textures.length);
  }

  // EXT_texture_webp goes into extensionsRequired, so it must only be declared
  // when a WebP texture actually survived the pass.
  const webpExtension = document.createExtension(EXTTextureWebP);
  if (textures.some((texture) => texture.getMimeType() === 'image/webp')) {
    webpExtension.setRequired(true);
  } else {
    webpExtension.dispose();
  }

  const textureBytes = textures.reduce(
    (total, texture) => total + (texture.getImage()?.byteLength ?? 0),
    0,
  );

  return { textureBytes, skipped };
}
