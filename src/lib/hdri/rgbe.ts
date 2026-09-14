/**
 * Radiance (`.hdr`) reader and writer. Pure. Runs unchanged in Node and the
 * browser, which is what lets the preset script and the in-app converter emit
 * byte-identical files.
 *
 * The writer produces the run-length-encoded flavour every other tool writes
 * (Blender, Photoshop, `hdrview`), falling back to the flat layout for widths
 * outside the range the format allows RLE in. Both paths decode in three's
 * `HDRLoader`.
 */

import type { LinearImageF32 } from './types.ts';

/** RLE is only legal in this width range; three's reader has the same guard. */
const RLE_MIN_WIDTH = 8;
const RLE_MAX_WIDTH = 0x7fff;

/** Shorter repeats are cheaper inside a literal run than as a coded run. */
const MIN_RUN = 4;

const MAGIC = '#?RADIANCE';

/**
 * Writes one RLE scanline from a channel-major `R…R G…G B…B E…E` buffer.
 *
 * Ported from Radiance's `fwritecolrs`. The literal-run length is chunked at
 * 128 *before* advancing rather than after: a literal count of 129 or 130 is
 * read back as `count > 128`, i.e. as a *coded* run, which desynchronises the
 * scanline and makes three throw "bad scanline data".
 */
function writeScanlineRLE(
  channels: Uint8Array,
  width: number,
  out: Uint8Array,
  outPos: number,
): number {
  let pos = outPos;
  out[pos++] = 2;
  out[pos++] = 2;
  out[pos++] = (width >> 8) & 0xff;
  out[pos++] = width & 0xff;

  for (let channel = 0; channel < 4; channel++) {
    const base = channel * width;
    let i = 0;

    while (i < width) {
      // Walk forward to the start of the next run worth coding.
      let beg = i;
      let run = 1;
      for (; beg < width; beg += run) {
        run = 1;
        while (run < 127 && beg + run < width && channels[base + beg + run] === channels[base + beg]) {
          run++;
        }
        if (run >= MIN_RUN) break;
      }

      // A 2- or 3-byte repeat immediately before a coded run is one byte
      // cheaper as its own short run than as the tail of a literal.
      if (beg - i > 1 && beg - i < MIN_RUN) {
        let uniform = true;
        for (let j = i + 1; j < beg; j++) {
          if (channels[base + j] !== channels[base + i]) {
            uniform = false;
            break;
          }
        }
        if (uniform) {
          out[pos++] = 128 + (beg - i);
          out[pos++] = channels[base + i];
          i = beg;
        }
      }

      while (i < beg) {
        let count = Math.min(128, beg - i);
        out[pos++] = count;
        while (count-- > 0) out[pos++] = channels[base + i++];
      }

      if (run >= MIN_RUN) {
        out[pos++] = 128 + run;
        out[pos++] = channels[base + beg];
        i += run;
      }
    }
  }

  return pos;
}

/** Converts one linear RGB triple into the four RGBE bytes, at `out[offset…]`. */
function encodePixel(r: number, g: number, b: number, out: Uint8Array, offsets: Int32Array): void {
  const peak = Math.max(r, g, b);
  if (!(peak > 1e-32)) {
    out[offsets[0]] = 0;
    out[offsets[1]] = 0;
    out[offsets[2]] = 0;
    out[offsets[3]] = 0;
    return;
  }
  let exponent = Math.floor(Math.log2(peak)) + 1;
  if (exponent < -127) exponent = -127;
  else if (exponent > 127) exponent = 127;
  // Canonical Radiance mantissa scale. The `+ 0.5` centres each quantisation
  // bin; truncating instead biases every value low and doubles the mean error.
  const scale = 256 / 2 ** exponent;
  out[offsets[0]] = Math.min(255, r * scale + 0.5) | 0;
  out[offsets[1]] = Math.min(255, g * scale + 0.5) | 0;
  out[offsets[2]] = Math.min(255, b * scale + 0.5) | 0;
  out[offsets[3]] = exponent + 128;
}

export type EncodeRGBEOptions = {
  /** Written into the header only; the pixel data is never scaled by it. */
  exposure?: number;
  /** Extra `# …` header lines, e.g. the source file name. */
  comments?: readonly string[];
};

/** Encodes a canonical top-down linear image as a Radiance `.hdr` file. */
export function encodeRGBE(image: LinearImageF32, options: EncodeRGBEOptions = {}): Uint8Array {
  const { width, height, data } = image;
  if (width <= 0 || height <= 0) throw new Error('encodeRGBE: empty image');
  if (image.components !== 3) throw new Error('encodeRGBE: expects 3 interleaved components');
  if (data.length < width * height * 3) throw new Error('encodeRGBE: data shorter than width * height * 3');

  const lines = [MAGIC];
  for (const comment of options.comments ?? []) {
    lines.push(`# ${comment.replace(/[\r\n]+/g, ' ')}`);
  }
  lines.push('FORMAT=32-bit_rle_rgbe');
  lines.push(`EXPOSURE=${(options.exposure ?? 1).toFixed(6)}`);
  // The blank line terminates the header; the resolution line's exact spacing
  // is what three's `-Y h +X w` regex matches on.
  lines.push('');
  lines.push(`-Y ${height} +X ${width}`);
  lines.push('');
  const header = new TextEncoder().encode(lines.join('\n'));

  const useRLE = width >= RLE_MIN_WIDTH && width <= RLE_MAX_WIDTH;
  // Worst case per scanline is all-literal: one length byte per 128 payload
  // bytes, plus the 4-byte scanline header.
  const maxScanline = useRLE ? 4 + 4 * (width + Math.ceil(width / 128) + 1) : 4 * width;
  const out = new Uint8Array(header.length + height * maxScanline);
  out.set(header, 0);
  let pos = header.length;

  if (useRLE) {
    const channels = new Uint8Array(4 * width);
    const offsets = new Int32Array(4);
    for (let y = 0; y < height; y++) {
      let src = y * width * 3;
      for (let x = 0; x < width; x++, src += 3) {
        offsets[0] = x;
        offsets[1] = width + x;
        offsets[2] = 2 * width + x;
        offsets[3] = 3 * width + x;
        encodePixel(data[src], data[src + 1], data[src + 2], channels, offsets);
      }
      pos = writeScanlineRLE(channels, width, out, pos);
    }
  } else {
    const offsets = new Int32Array(4);
    for (let y = 0; y < height; y++) {
      let src = y * width * 3;
      for (let x = 0; x < width; x++, src += 3) {
        offsets[0] = pos;
        offsets[1] = pos + 1;
        offsets[2] = pos + 2;
        offsets[3] = pos + 3;
        encodePixel(data[src], data[src + 1], data[src + 2], out, offsets);
        pos += 4;
      }
    }
  }

  return out.subarray(0, pos);
}

export type RGBEHeader = { width: number; height: number; bodyStart: number };

/** Reads a Radiance header: dimensions plus where the pixel data begins. */
export function probeRGBE(bytes: Uint8Array): RGBEHeader | null {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (!text.startsWith(MAGIC) && !text.startsWith('#?RGBE')) return null;
  const dimensions = /^\s*-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/m.exec(text);
  if (!dimensions) return null;
  return {
    height: Number(dimensions[1]),
    width: Number(dimensions[2]),
    bodyStart: dimensions.index + dimensions[0].length + 1,
  };
}

/**
 * Minimal `.hdr` reader, used by the self-test so `rgbe.ts` can be verified
 * without pulling in three. Decodes with three's `2^(e-128) / 255` scale rather
 * than Radiance's `(v + 0.5) / 256` so the numbers match what the app will
 * actually see; for the mantissa range the writer produces the two agree to
 * within 0.2 %.
 */
export function decodeRGBE(bytes: Uint8Array): LinearImageF32 {
  const header = probeRGBE(bytes);
  if (!header) throw new Error('decodeRGBE: not a Radiance file');
  const { width, height, bodyStart } = header;

  const rgbe = new Uint8Array(4 * width * height);
  const body = bytes.subarray(bodyStart);
  const flat =
    width < RLE_MIN_WIDTH ||
    width > RLE_MAX_WIDTH ||
    body[0] !== 2 ||
    body[1] !== 2 ||
    (body[2] & 0x80) !== 0;

  if (flat) {
    rgbe.set(body.subarray(0, rgbe.length));
  } else {
    const scanline = new Uint8Array(4 * width);
    let pos = 0;
    for (let y = 0; y < height; y++) {
      if (body[pos] !== 2 || body[pos + 1] !== 2 || ((body[pos + 2] << 8) | body[pos + 3]) !== width) {
        throw new Error(`decodeRGBE: bad scanline header at row ${y}`);
      }
      pos += 4;
      let ptr = 0;
      while (ptr < scanline.length) {
        let count = body[pos++];
        const coded = count > 128;
        if (coded) count -= 128;
        if (count === 0 || ptr + count > scanline.length) {
          throw new Error(`decodeRGBE: bad scanline data at row ${y}`);
        }
        if (coded) {
          const value = body[pos++];
          for (let i = 0; i < count; i++) scanline[ptr++] = value;
        } else {
          scanline.set(body.subarray(pos, pos + count), ptr);
          ptr += count;
          pos += count;
        }
      }
      let dst = y * width * 4;
      for (let x = 0; x < width; x++, dst += 4) {
        rgbe[dst] = scanline[x];
        rgbe[dst + 1] = scanline[width + x];
        rgbe[dst + 2] = scanline[2 * width + x];
        rgbe[dst + 3] = scanline[3 * width + x];
      }
    }
  }

  const data = new Float32Array(width * height * 3);
  let maxComponent = 0;
  for (let i = 0, o = 0; i < rgbe.length; i += 4, o += 3) {
    const exponent = rgbe[i + 3];
    if (exponent === 0) continue;
    const scale = 2 ** (exponent - 128) / 255;
    const r = rgbe[i] * scale;
    const g = rgbe[i + 1] * scale;
    const b = rgbe[i + 2] * scale;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    if (r > maxComponent) maxComponent = r;
    if (g > maxComponent) maxComponent = g;
    if (b > maxComponent) maxComponent = b;
  }

  return { data, dataType: 'float32', components: 3, width, height, isHDR: true, maxComponent };
}
