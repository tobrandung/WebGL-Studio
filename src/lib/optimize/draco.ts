/**
 * Loads the Draco encoder and decoder in a browser worker.
 *
 * Both are needed. The encoder is the point of the feature; the decoder is
 * needed just to *read* a GLB that is already Draco-compressed. GlTF-Transform
 * refuses such a file without it, and re-optimising an already-optimised model
 * is an obvious thing for a user to do.
 *
 * Two dead ends worth recording, because both look like the obvious choice:
 *
 * - `three/examples/jsm/libs/draco/gltf/draco_encoder.js` cannot be imported.
 *   three is `type: module`, so that file is parsed as ESM, its UMD tail is
 *   `typeof`-guarded and silently no-ops, and the import resolves to `{}`.
 *   three loads it with a script tag. Even eval-loaded it is useless here:
 *   that build has no `ExpertEncoder`, which is exactly what glTF-Transform
 *   calls.
 *
 * - `draco3dgltf`'s package entry `require`s the `_nodejs` glue, so a bare
 *   `import 'draco3dgltf'` drags `fs` into the bundle.
 *
 * What works is the `_nodejs` glue itself: despite the filename it is a
 * universal emscripten build with the full API, and it honours an explicitly
 * supplied `wasmBinary`. That last part is not optional. In a module worker
 * `window`, `importScripts` and `process` are all absent, so every one of its
 * own wasm-fetching branches is skipped and it throws "both async and sync
 * fetching of the wasm failed".
 */

// `?raw` keeps the glue's static `require('fs')`/`require('path')` away from
// the bundler; we hand it a fake CommonJS scope instead.
import encoderGlue from 'draco3dgltf/draco_encoder_gltf_nodejs.js?raw';
import encoderWasmUrl from 'draco3dgltf/draco_encoder.wasm?url';
import decoderGlue from 'draco3dgltf/draco_decoder_gltf_nodejs.js?raw';
import decoderWasmUrl from 'draco3dgltf/draco_decoder_gltf.wasm?url';

type EmscriptenFactory = (options: { wasmBinary: Uint8Array }) => Promise<Record<string, unknown>>;

/**
 * Evaluates an emscripten glue file in a fake CommonJS scope and instantiates
 * it against a wasm binary we fetch ourselves.
 */
export async function instantiateDraco(
  glueSource: string,
  wasmUrl: string,
  expectedSymbol: string,
): Promise<Record<string, unknown>> {
  const scope = { exports: {} as unknown };
  const factory = new Function(
    'module',
    'exports',
    `${glueSource}\nreturn module.exports;`,
  )(scope, scope.exports) as EmscriptenFactory;

  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`Draco: WASM nicht ladbar (${response.status})`);
  const wasmBinary = new Uint8Array(await response.arrayBuffer());

  const module = await factory({ wasmBinary });
  if (typeof module[expectedSymbol] !== 'function') {
    throw new Error(`Draco: unerwartete API, ${expectedSymbol} fehlt`);
  }
  return module;
}

let encoderPromise: Promise<unknown> | null = null;
let decoderPromise: Promise<unknown> | null = null;

/** Instantiated once per worker; its 370 KB wasm loads only when Draco is on. */
export function loadDracoEncoder(): Promise<unknown> {
  encoderPromise ??= instantiateDraco(encoderGlue, encoderWasmUrl, 'ExpertEncoder');
  return encoderPromise;
}

/** Only needed for sources that already carry KHR_draco_mesh_compression. */
export function loadDracoDecoder(): Promise<unknown> {
  decoderPromise ??= instantiateDraco(decoderGlue, decoderWasmUrl, 'Decoder');
  return decoderPromise;
}
