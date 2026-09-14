/**
 * The optimize pipeline, split into the stages the dialog drives separately.
 *
 * The split is not cosmetic. Draco encodes during `writeBinary()`, not as a
 * Document mutation, so every write re-encodes every primitive. Seconds on a
 * large mesh. And glTF-Transform transforms mutate the Document in place,
 * while `cloneDocument()` copies every buffer, which is unaffordable at 50 MB.
 * So: clean once, re-run only the (idempotent) texture pass while the user
 * drags a slider, and write for real only when geometry settings change or the
 * user confirms.
 *
 * This module stays free of browser-only imports. The texture pass and the
 * encoder are injected. So `scripts/optimize-selftest.ts` can drive the exact
 * same code under Node.
 */

import { Document, WebIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { dedup, draco, inspect, prune, weld } from '@gltf-transform/functions';
import type { OptimizeSettings, SourceAnalysis, TextureReport } from './types.ts';

/** Lazily supplies a Draco module; injected so this file stays Node-runnable. */
export type DracoProvider = () => Promise<unknown>;

/** `InspectTextureReport.resolution` is a string like "2048x1024". */
function parseResolution(resolution: string): [number, number] {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/.exec(resolution.trim());
  if (!match) return [0, 0];
  return [Number(match[1]), Number(match[2])];
}

function createIO(): WebIO {
  return new WebIO()
    .setLogger(new Logger(Logger.Verbosity.ERROR))
    .registerExtensions(ALL_EXTENSIONS);
}

/**
 * Reads a GLB, registering the Draco decoder only when the file actually needs
 * it. Peeking at the JSON chunk first keeps a plain GLB from paying for
 * 190 KB of wasm, while a re-optimise of an already-compressed model still
 * works. GlTF-Transform throws outright without the decoder.
 */
export async function readDocument(
  buffer: ArrayBuffer | Uint8Array,
  loadDecoder?: DracoProvider,
): Promise<Document> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const io = createIO();

  if (loadDecoder) {
    const { json } = await io.binaryToJSON(bytes);
    if (json.extensionsUsed?.includes(KHRDracoMeshCompression.EXTENSION_NAME)) {
      io.registerDependencies({ 'draco3d.decoder': await loadDecoder() });
    }
  }

  return io.readBinary(bytes);
}

/**
 * Length of a GLB's JSON chunk, read straight off the container header:
 * 12-byte file header, then each chunk is a 4-byte length + 4-byte type. The
 * JSON chunk is always first.
 */
export function jsonChunkBytes(bytes: Uint8Array): number {
  if (bytes.byteLength < 20) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) return 0; // 'glTF'
  const chunkLength = view.getUint32(12, true);
  return 12 + 8 + chunkLength;
}

/**
 * Byte accounting for the UI and the estimator.
 *
 * Measured against the container, not derived from `inspect()`: for a
 * Draco-compressed source `inspect().meshes` reports *decoded* bytes, which
 * can exceed the whole file, so subtracting it produces garbage. Images are
 * summed from the Document (exact, and exactly what the texture pass will
 * replace), the JSON chunk is read off the header, and geometry is what
 * remains of the BIN chunk. The mesh reports are still taken from `inspect()`,
 * because the estimator needs their vertex and attribute counts.
 */
export function analyzeDocument(document: Document, bytes: Uint8Array): SourceAnalysis {
  const report = inspect(document);
  const fileSize = bytes.byteLength;

  const textures: TextureReport[] = report.textures.properties.map((texture, index) => {
    const [width, height] = parseResolution(texture.resolution);
    return {
      index,
      name: texture.name || texture.uri || `Textur ${index + 1}`,
      slots: texture.slots,
      mimeType: texture.mimeType,
      width,
      height,
      size: texture.size ?? 0,
      gpuSize: texture.gpuSize ?? 0,
    };
  });

  const meshes = report.meshes.properties.map((mesh) => ({
    name: mesh.name,
    vertices: mesh.vertices,
    glPrimitives: mesh.glPrimitives,
    primitives: mesh.meshPrimitives,
    attributes: mesh.attributes,
    decodedSize: mesh.size ?? 0,
  }));

  const textureBytes = currentTextureBytes(document);
  const gpuBytes = textures.reduce((sum, texture) => sum + texture.gpuSize, 0);
  const residualBytes = jsonChunkBytes(bytes);

  return {
    fileSize,
    textureBytes,
    geometryBytes: Math.max(0, fileSize - textureBytes - residualBytes),
    residualBytes,
    gpuBytes,
    sourceIsDraco: document
      .getRoot()
      .listExtensionsUsed()
      .some((extension) => extension.extensionName === KHRDracoMeshCompression.EXTENSION_NAME),
    textures,
    meshes,
  };
}

/**
 * Prune, deduplicate and weld. The three that always run. None of them can
 * change how the model looks: prune only drops unreferenced properties, dedup
 * only collapses bitwise-identical ones, and weld (at its default tolerance)
 * only merges vertices that are already identical. Weld also produces the
 * indexed geometry Draco needs to be effective.
 */
export async function cleanDocument(document: Document): Promise<void> {
  await document.transform(prune(), dedup(), weld());
}

/**
 * Serialises the Document, applying Draco on the way out if requested. The
 * encoder is supplied by the caller and only asked for when Draco is on, so a
 * texture-only run never pays for its wasm.
 */
export async function writeDocument(
  document: Document,
  settings: Pick<OptimizeSettings, 'draco'>,
  loadEncoder: DracoProvider,
): Promise<Uint8Array> {
  const io = createIO();

  if (settings.draco) {
    io.registerDependencies({ 'draco3d.encoder': await loadEncoder() });
    await document.transform(draco());
  } else {
    // Re-running with Draco switched off has to remove the extension again,
    // or the writer keeps compressing from the previous run.
    document
      .getRoot()
      .listExtensionsUsed()
      .filter((extension) => extension.extensionName === KHRDracoMeshCompression.EXTENSION_NAME)
      .forEach((extension) => extension.dispose());
  }

  return io.writeBinary(document);
}

/** Bytes of every texture currently held by the Document. */
export function currentTextureBytes(document: Document): number {
  return document
    .getRoot()
    .listTextures()
    .reduce((total, texture) => total + (texture.getImage()?.byteLength ?? 0), 0);
}
