/**
 * Environment-format identification. Pure, no imports beyond the shared types.
 *
 * An Ultra HDR file is a `.jpg` that must go to `UltraHDRLoader`; handing it to
 * `TextureLoader` succeeds but decodes only the SDR base layer, silently
 * producing a flat, dim environment. So format is recorded explicitly on the
 * project record, encoded into the exported file name as a fallback for callers
 * that only have a URL, and sniffable from the bytes as a last resort.
 */

import type { EnvironmentFormat } from './types.ts';

/** Extensions the environment upload accepts. */
export const ACCEPTED_ENVIRONMENT_EXTENSIONS = ['.hdr', '.exr', '.jpg', '.jpeg', '.png', '.webp'] as const;

/**
 * Marks a JPEG that carries an HDR gain map. Checked before the generic `.jpg`
 * rule so the widget gets the right answer from a bare CDN URL.
 */
const ULTRAHDR_SUFFIX = /\.uhdr\.jpe?g$/i;

/** Strips a query string or fragment, so URLs work as well as file names. */
function baseName(nameOrUrl: string): string {
  const clean = nameOrUrl.split(/[?#]/, 1)[0];
  const slash = clean.lastIndexOf('/');
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

export function extensionOf(nameOrUrl: string): string {
  const name = baseName(nameOrUrl);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

export function isSupportedEnvironmentFile(fileName: string): boolean {
  return (ACCEPTED_ENVIRONMENT_EXTENSIONS as readonly string[]).includes(extensionOf(fileName));
}

export function formatFromFileName(nameOrUrl: string): EnvironmentFormat {
  const name = baseName(nameOrUrl);
  if (ULTRAHDR_SUFFIX.test(name)) return 'ultrahdr';
  switch (extensionOf(name)) {
    case '.hdr':
      return 'hdr';
    case '.exr':
      return 'exr';
    default:
      return 'sdr';
  }
}

/** File extension a converted output should carry, including the UHDR marker. */
export function extensionForFormat(format: EnvironmentFormat): string {
  switch (format) {
    case 'hdr':
      return '.hdr';
    case 'exr':
      return '.exr';
    case 'ultrahdr':
      return '.uhdr.jpg';
    default:
      return '.webp';
  }
}

export const ENVIRONMENT_FORMAT_LABEL: Record<EnvironmentFormat, string> = {
  hdr: 'Radiance HDR',
  exr: 'OpenEXR',
  ultrahdr: 'Ultra HDR JPEG',
  sdr: 'SDR-Bild',
};

/** Case-sensitive ASCII substring search over a byte range. */
function containsAscii(bytes: Uint8Array, needle: string, limit: number): boolean {
  const end = Math.min(bytes.byteLength, limit);
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i + needle.length <= end; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

/** Legacy XMP namespace that gain-map encoders write. */
const GAINMAP_XMP_NS = 'http://ns.adobe.com/hdr-gain-map/1.0/';
/** ISO 21496-1 APP2 namespace, the current standard. */
const GAINMAP_ISO_NS = 'urn:iso:std:iso:ts:21496:-1';

const SNIFF_BYTES = 1 << 16;

/**
 * Identifies a format from the leading bytes, falling back to the file name.
 * Robust against a mislabelled extension, and the only way to tell an Ultra HDR
 * JPEG from a plain one when the name carries no marker.
 */
export function sniffEnvironmentFormat(head: Uint8Array, fileName = ''): EnvironmentFormat {
  if (head.byteLength >= 4) {
    const view = new DataView(head.buffer, head.byteOffset, Math.min(head.byteLength, 8));
    if (view.getUint32(0, true) === 0x01312f76) return 'exr';
    if (containsAscii(head.subarray(0, 16), '#?RADIANCE', 16) || containsAscii(head.subarray(0, 16), '#?RGBE', 16)) {
      return 'hdr';
    }
    // JPEG SOI: could be plain SDR or an Ultra HDR gain-map container.
    if (head[0] === 0xff && head[1] === 0xd8) {
      if (containsAscii(head, GAINMAP_XMP_NS, SNIFF_BYTES) || containsAscii(head, GAINMAP_ISO_NS, SNIFF_BYTES)) {
        return 'ultrahdr';
      }
      return 'sdr';
    }
  }
  return formatFromFileName(fileName);
}

/**
 * Local copy of `slugify` from `@/lib/utils`. Duplicated rather than imported
 * because that module pulls in clsx and tailwind-merge at module scope, which
 * the Node preset script has no business loading.
 */
export function slugifyName(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'hdri'
  );
}

/**
 * Content type an environment blob is stored and served under. Derived from the
 * format rather than the file name for the same reason `extensionForFormat` is:
 * an Ultra HDR file is a `.jpg` whose decoder cannot be guessed from its
 * extension.
 *
 * Note that `hdr` and `exr` are deliberately outside ALLOWED_CONTENT_TYPES: the
 * raw formats are megabytes per file and have no place on a web page, so they
 * are converted before publishing and the uploader rejects them by type.
 */
export const ENVIRONMENT_CONTENT_TYPE: Record<EnvironmentFormat, string> = {
  hdr: 'image/vnd.radiance',
  exr: 'image/x-exr',
  ultrahdr: 'image/jpeg',
  sdr: 'image/webp',
};
