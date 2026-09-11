export type AssetInput = {
  data: ArrayBuffer;
  /** One of ALLOWED_CONTENT_TYPES. */
  contentType: string;
  /** Lower-case extension without the dot, e.g. `glb`, `webp`, `uhdr.jpg`. */
  extension: string;
};

export type AssetRef = {
  /** Content-addressed storage key, e.g. `a/1a2b3c4d5e6f7a8b.glb`. */
  key: string;
  /** Public, permanently cacheable URL the embed snippet points at. */
  url: string;
  /** True when the bytes were already stored and no upload happened. */
  skipped: boolean;
};

export type UploadProgress = (loaded: number, total: number) => void;
