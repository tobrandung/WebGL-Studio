/**
 * Pure image geometry: target sizes and header-only dimension reads.
 *
 * Kept apart from `texture-pass.ts` so that the estimator and the Node
 * self-test can use it without dragging in `createImageBitmap` and the canvas.
 */

/**
 * iOS Safari silently returns blank pixels above roughly 16.7 Mpx of canvas
 * area rather than throwing, so a 4096² texture sits exactly on the edge.
 * Staying below keeps the pass from producing invisible textures on iPads
 * with no error to go on.
 */
const MAX_CANVAS_PIXELS = 16_000_000;

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

/** Decoded RGBA bytes a texture occupies on the GPU, mipmaps included. */
export function gpuBytesFor(width: number, height: number): number {
  return Math.round(width * height * 4 * (4 / 3));
}

/**
 * Minimal PNG/JPEG/WebP header parse. Dimensions only. Reading the header
 * costs microseconds where a decode costs tens of milliseconds, and choosing
 * a target size does not need the pixels.
 */
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
        // SOF0-SOF15, minus the DHT/DAC/DNL markers that share the range.
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          return [view.getUint16(offset + 7, false), view.getUint16(offset + 5, false)];
        }
        offset += 2 + length;
      }
      return null;
    }
    if (mimeType === 'image/webp') {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      // VP8X carries the canvas size as two 24-bit values, minus one.
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
