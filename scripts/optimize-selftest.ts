/**
 * Self-test for the GLB optimize pipeline. Run with `npm run optimize:selftest`.
 *
 * The point is to prove the *browser* path before any UI exists, so the Draco
 * encoder is loaded here exactly the way `src/lib/optimize/draco-encoder.ts`
 * loads it in a worker: the universal emscripten glue evaluated in a fake
 * CommonJS scope, with `wasmBinary` handed in explicitly. Reading the two
 * files off disk is the only difference — in the browser the bundler supplies
 * them as `?raw` and `?url`. If this passes and the browser still fails, the
 * bundler is at fault, not the encoder.
 *
 * The texture pass is browser-only (`createImageBitmap`) and is not exercised
 * here; it gets its first real run in the dialog.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  analyzeDocument,
  cleanDocument,
  currentTextureBytes,
  readDocument,
  writeDocument,
} from '../src/lib/optimize/pipeline.ts';

const require = createRequire(import.meta.url);

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Mirrors src/lib/optimize/draco.ts, minus the bundler's `?raw` / `?url`. */
async function loadDraco(kind: 'encoder' | 'decoder'): Promise<unknown> {
  const glueName =
    kind === 'encoder' ? 'draco_encoder_gltf_nodejs.js' : 'draco_decoder_gltf_nodejs.js';
  const wasmName = kind === 'encoder' ? 'draco_encoder.wasm' : 'draco_decoder_gltf.wasm';
  const expected = kind === 'encoder' ? 'ExpertEncoder' : 'Decoder';

  const glueSource = await readFile(require.resolve(`draco3dgltf/${glueName}`), 'utf8');
  const wasmBinary = new Uint8Array(await readFile(require.resolve(`draco3dgltf/${wasmName}`)));

  // Shadowing `process` and `require` is what makes this a test of the browser
  // path rather than the Node one. The glue picks its wasm-loading strategy by
  // sniffing globals: with `process` visible it takes the `require('fs')`
  // branch, which exists in Node but not in a worker. Hidden, it falls through
  // to the same branch a module worker hits — and because `wasmBinary` is
  // supplied, it uses that instead of trying to fetch.
  const scope = { exports: {} as unknown };
  const factory = new Function(
    'module',
    'exports',
    'process',
    'require',
    `${glueSource}\nreturn module.exports;`,
  )(scope, scope.exports, undefined, undefined) as (options: {
    wasmBinary: Uint8Array;
  }) => Promise<Record<string, unknown>>;

  const module = await factory({ wasmBinary });
  check(`Draco-${kind} instanziiert`, typeof module[expected] === 'function');
  return module;
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? 'assets/porsche-911.glb';
  const source = await readFile(path);
  console.log(`\nGLB-Optimierung — Selftest (${path}, ${mb(source.byteLength)})\n`);

  const loadDecoder = () => loadDraco('decoder');
  const bytes = new Uint8Array(source);
  const document = await readDocument(bytes, loadDecoder);
  const analysis = analyzeDocument(document, bytes);

  console.log(
    `  Analyse: ${analysis.textures.length} Texturen (${mb(analysis.textureBytes)}), ` +
      `Geometrie ${mb(analysis.geometryBytes)}, JSON ${mb(analysis.residualBytes)}, ` +
      `GPU ${mb(analysis.gpuBytes)}${analysis.sourceIsDraco ? ', Quelle bereits Draco' : ''}`,
  );
  check(
    'Byte-Aufteilung geht exakt auf',
    analysis.textureBytes + analysis.geometryBytes + analysis.residualBytes === analysis.fileSize,
    `${analysis.textureBytes} + ${analysis.geometryBytes} + ${analysis.residualBytes} = ${analysis.fileSize}`,
  );
  check(
    'Draco-Quelle wird erkannt',
    analysis.sourceIsDraco === /porsche-911\.glb$/.test(path),
    String(analysis.sourceIsDraco),
  );

  const beforeTextures = currentTextureBytes(document);
  await cleanDocument(document);
  check(
    'Aufräumen ändert keine Texturbytes',
    currentTextureBytes(document) <= beforeTextures,
    `${mb(beforeTextures)} → ${mb(currentTextureBytes(document))}`,
  );

  const compressed = await writeDocument(document, { draco: true }, () => loadDraco('encoder'));
  check(
    'Draco-Ausgabe kleiner als die Quelle',
    compressed.byteLength < source.byteLength,
    `${mb(source.byteLength)} → ${mb(compressed.byteLength)}`,
  );

  const roundTrip = await readDocument(compressed, loadDecoder);
  const after = analyzeDocument(roundTrip, compressed);

  // dedup() collapses identical meshes, so the count may legitimately drop —
  // it must not go to zero, and the vertices have to survive.
  check(
    'Ausgabe ist wieder lesbar',
    after.meshes.length > 0 && after.meshes.length <= analysis.meshes.length,
    `${analysis.meshes.length} → ${after.meshes.length} Meshes`,
  );
  const verticesBefore = analysis.meshes.reduce((n, m) => n + m.vertices, 0);
  const verticesAfter = after.meshes.reduce((n, m) => n + m.vertices, 0);
  check(
    'Vertices überleben den Roundtrip',
    verticesAfter > verticesBefore * 0.5,
    `${verticesBefore} → ${verticesAfter}`,
  );
  check(
    'KHR_draco_mesh_compression deklariert',
    roundTrip
      .getRoot()
      .listExtensionsUsed()
      .some((e) => e.extensionName === 'KHR_draco_mesh_compression'),
  );

  check(
    'Ausgabe-Aufteilung geht exakt auf',
    after.textureBytes + after.geometryBytes + after.residualBytes === after.fileSize,
  );

  console.log(
    `\n  Texturen (in diesem Lauf unangetastet): ${mb(analysis.textureBytes)} → ${mb(after.textureBytes)}` +
      `\n  Geometrie:                              ${mb(analysis.geometryBytes)} → ${mb(after.geometryBytes)}` +
      ` (${(analysis.geometryBytes / Math.max(1, after.geometryBytes)).toFixed(1)}× kleiner)`,
  );

  console.log(failures === 0 ? '\n  alle Prüfungen bestanden\n' : `\n  ${failures} Fehler\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
