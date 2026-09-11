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
