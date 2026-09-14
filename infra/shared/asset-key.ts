/**
 * Re-export, not a copy. The rules live in the app tree because the browser
 * needs them too, and a second definition here would drift.
 */
export {
  isValidAssetKey,
  checksumMatchesKey,
  keyDigestPrefix,
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  IMMUTABLE_CACHE_CONTROL,
} from '../../src/lib/storage/asset-key.ts';
