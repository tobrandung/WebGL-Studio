/**
 * Shared shapes for the GLB optimizer. Kept free of three.js and of
 * @gltf-transform imports so the main thread can talk about jobs and results
 * without pulling the pipeline into its bundle.
 */

/** Texture container the pass writes. `keep` leaves the source encoding alone. */
export type TextureFormat = 'webp' | 'keep';

/** Longest edge a texture may have after the pass. */
export type MaxTextureSize = 512 | 1024 | 2048 | 4096;

export type OptimizeSettings = {
  textureFormat: TextureFormat;
  maxTextureSize: MaxTextureSize;
  /** 0..1, passed to the WebP encoder. Normal maps override this upwards. */
  textureQuality: number;
  /** Draco geometry compression (KHR_draco_mesh_compression). */
  draco: boolean;
};

export const DEFAULT_SETTINGS: OptimizeSettings = {
  textureFormat: 'webp',
  maxTextureSize: 2048,
  textureQuality: 0.85,
  draco: true,
};

/**
 * Normal maps carry direction vectors, not colour: lossy compression bends
 * them and the error shows up as banding in the specular highlight, which
 * reads as a broken material rather than a soft image. They get their own
 * floor regardless of the slider.
 */
export const NORMAL_MAP_MIN_QUALITY = 0.95;

/** Stage of an optimize job, in the order they run. */
export type OptimizePhase = 'parse' | 'clean' | 'textures' | 'geometry' | 'write';

export type OptimizeProgress = {
  phase: OptimizePhase;
  /** 0..1 over the whole job, monotonically non-decreasing. */
  progress: number;
  /** German label for the current stage, ready to render. */
  label: string;
};

/** What one texture costs, before and after — the basis for the UI breakdown. */
export type TextureReport = {
  index: number;
  name: string;
  slots: string[];
  mimeType: string;
  width: number;
  height: number;
  /** Bytes in the container. */
  size: number;
  /** Decoded RGBA bytes incl. mipmaps — what the texture costs in VRAM. */
  gpuSize: number;
};

export type MeshReport = {
  name: string;
  vertices: number;
  glPrimitives: number;
  primitives: number;
  attributes: string[];
  /** Decoded accessor bytes — NOT what the mesh occupies in a Draco file. */
  decodedSize: number;
};

/**
 * Byte accounting of the source file.
 *
 * Measured against the GLB container rather than derived from `inspect()`:
 * for a Draco-compressed source `inspect()` reports *decoded* mesh bytes,
 * which can exceed the whole file and makes any subtraction nonsense. The
 * container split (JSON chunk / images / the rest of the BIN chunk) is exact
 * for compressed and uncompressed sources alike.
 */
export type SourceAnalysis = {
  fileSize: number;
  /** Sum of the embedded image buffers — exactly what the texture pass edits. */
  textureBytes: number;
  /** Everything left in the BIN chunk: geometry and animation, as stored. */
  geometryBytes: number;
  /** The glTF JSON chunk plus container padding. Passes through unchanged. */
  residualBytes: number;
  /** Decoded RGBA bytes incl. mipmaps across all textures. */
  gpuBytes: number;
  /** Whether the source already carries KHR_draco_mesh_compression. */
  sourceIsDraco: boolean;
  textures: TextureReport[];
  meshes: MeshReport[];
};

/** A size projection, either calculated or actually encoded. */
export type SizeBreakdown = {
  total: number;
  textureBytes: number;
  geometryBytes: number;
  residualBytes: number;
  gpuBytes: number;
  /** False while this is a calculation rather than a real encode. */
  measured: boolean;
};

export type OptimizeResult = {
  buffer: ArrayBuffer;
  size: number;
  breakdown: SizeBreakdown;
};
