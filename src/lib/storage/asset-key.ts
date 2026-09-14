/**
 * The contract between the browser and the two Workers: key grammar, allowed
 * content types, and the size ceiling.
 *
 * Deliberately a dependency-free module under src/ that infra/ re-exports — the
 * same arrangement src/lib/optimize/pipeline.ts uses to stay runnable under
 * Node. A client that computes keys by one rule and a Worker that validates
 * them by another would fail only for the files where the rules disagree, which
 * is exactly the bug that never shows up in testing.
 *
 *   a/<16 hex>.<ext>                  project assets (models, environments)
 *   w/<version>-<8 hex>/<file>.js     widget bundles
 *
 * Everything else is rejected, which doubles as the path-traversal guard: no
 * segment can be `.` or `..` and no key can escape its prefix.
 */
const ASSET_KEY = /^a\/[0-9a-f]{16}\.[a-z0-9.]{2,10}$/;
const WIDGET_KEY = /^w\/[0-9a-z.-]{1,32}-[0-9a-f]{8}\/[a-z0-9.-]{1,64}\.js$/;

export function isValidAssetKey(key: string): boolean {
  return ASSET_KEY.test(key) || WIDGET_KEY.test(key);
}

/**
 * Content types we are willing to store. A closed list rather than a check for
 * "looks like a media type": the CDN echoes this value back to browsers
 * verbatim, so an attacker-chosen value here would be an attacker-chosen
 * Content-Type there.
 */
export const ALLOWED_CONTENT_TYPES = new Set([
  'model/gltf-binary',
  'image/webp',
  'image/jpeg',
  'image/png',
  'text/javascript',
]);

/**
 * Hard ceiling for a single upload. The client refuses larger files, but that
 * check is a courtesy — the binding one is the signed Content-Length, which
 * makes R2 itself reject a mismatched body.
 *
 * Chosen so the R2 free tier (10 GB) holds a useful number of projects, and
 * because a model above it has no business being on a web page. Note this is
 * below MAX_DIRECT_BYTES in ModelUploadDialog: the editor will happily work
 * with a bigger model locally, it just cannot be published before optimizing.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Content-addressed assets never change, so they can be cached forever. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Base64 of a 32-byte digest: 43 payload characters plus one `=` of padding.
 */
const SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * The hex digest prefix a key claims to carry, or null for a shape that has
 * none.
 *
 *   a/1a2b3c4d5e6f7a8b.glb            → 1a2b3c4d5e6f7a8b  (8 bytes)
 *   w/1.4.0-1a2b3c4d/widget.iife.js   → 1a2b3c4d          (4 bytes)
 */
export function keyDigestPrefix(key: string): string | null {
  const asset = /^a\/([0-9a-f]{16})\./.exec(key);
  if (asset) return asset[1];
  const widget = /^w\/[0-9a-z.-]{1,32}-([0-9a-f]{8})\//.exec(key);
  return widget ? widget[1] : null;
}

/**
 * Does this SHA-256 digest actually produce this key?
 *
 * Content addressing is only a property of the system if someone checks it.
 * The Worker signs `x-amz-checksum-sha256` with the upload, so R2 refuses any
 * body whose digest differs — but that alone would only prove the client sent
 * *a* matching pair. Tying the digest back to the key here is what closes the
 * loop: the stored bytes must hash to the name they are stored under, so no
 * authenticated caller can park unrelated content on a key others link to and
 * have it cached at the edge for a year.
 *
 * Takes the digest as base64 because that is the wire format R2 expects.
 */
export function checksumMatchesKey(key: string, checksumBase64: string): boolean {
  if (!SHA256_BASE64.test(checksumBase64)) return false;
  const prefix = keyDigestPrefix(key);
  if (!prefix) return false;

  let binary: string;
  try {
    binary = atob(checksumBase64);
  } catch {
    return false;
  }
  if (binary.length !== 32) return false;

  let hex = '';
  for (let i = 0; i < prefix.length / 2; i += 1) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex === prefix;
}
