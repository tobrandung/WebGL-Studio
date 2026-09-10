/**
 * Optimizer worker. Holds one Document for the lifetime of the dialog so
 * repeated runs — which is what a settings panel produces — do not re-parse
 * a 50 MB file every time.
 *
 * Cancellation is by `worker.terminate()` from the client, same as the HDRI
 * converter: it is the only thing that stops a synchronous encode, and it
 * releases the whole heap at once. Nothing here needs an abort flag.
 */

import type { Document } from '@gltf-transform/core';
import { loadDracoDecoder, loadDracoEncoder } from './draco.ts';
import {
  analyzeDocument,
  cleanDocument,
  readDocument,
  writeDocument,
} from './pipeline.ts';
import {
  captureTextureOriginals,
  runTexturePass,
  type TextureOriginal,
} from './texture-pass.ts';
import type { OptimizeSettings, OptimizePhase, SourceAnalysis, SizeBreakdown } from './types.ts';

export type OptimizeRequest =
  | { type: 'open'; id: number; buffer: ArrayBuffer }
  | { type: 'run'; id: number; settings: OptimizeSettings; wantBuffer: boolean };

export type OptimizeResponse =
  | { type: 'opened'; id: number; analysis: SourceAnalysis }
  | { type: 'progress'; id: number; phase: OptimizePhase; progress: number; label: string }
  | { type: 'result'; id: number; breakdown: SizeBreakdown; buffer?: ArrayBuffer }
  | { type: 'error'; id: number; message: string };

const PHASE_LABEL: Record<OptimizePhase, string> = {
  parse: 'Modell wird gelesen…',
  clean: 'Wird aufgeräumt…',
  textures: 'Texturen werden komprimiert…',
  geometry: 'Geometrie wird komprimiert…',
  write: 'Datei wird geschrieben…',
};

/** Weights roughly matching where the wall time goes on a texture-heavy GLB. */
const PHASE_SPAN: Record<OptimizePhase, [number, number]> = {
  parse: [0, 0.1],
  clean: [0.1, 0.2],
  textures: [0.2, 0.75],
  geometry: [0.75, 0.9],
  write: [0.9, 1],
};

let document: Document | null = null;
let originals: TextureOriginal[] = [];
let analysis: SourceAnalysis | null = null;
/** JSON chunk + container overhead, which the pipeline passes through. */
let residualBytes = 0;

function post(message: OptimizeResponse, transfer?: Transferable[]): void {
  self.postMessage(message, { transfer });
}

function report(id: number, phase: OptimizePhase, fraction = 1): void {
  const [start, end] = PHASE_SPAN[phase];
  post({
    type: 'progress',
    id,
    phase,
    progress: start + (end - start) * Math.max(0, Math.min(1, fraction)),
    label: PHASE_LABEL[phase],
  });
}

async function open(id: number, buffer: ArrayBuffer): Promise<void> {
  report(id, 'parse', 0);
  const bytes = new Uint8Array(buffer);
  document = await readDocument(bytes, loadDracoDecoder);
  analysis = analyzeDocument(document, bytes);
  residualBytes = analysis.residualBytes;

  report(id, 'clean', 0);
  await cleanDocument(document);
  // Captured after cleaning so dedup has already collapsed duplicate images —
  // the pass then never encodes the same picture twice.
  originals = captureTextureOriginals(document);

  post({ type: 'opened', id, analysis });
}

async function run(id: number, settings: OptimizeSettings, wantBuffer: boolean): Promise<void> {
  if (!document || !analysis) throw new Error('Kein Modell geöffnet');

  report(id, 'textures', 0);
  const textures = await runTexturePass(document, originals, {
    textureFormat: settings.textureFormat,
    maxTextureSize: settings.maxTextureSize,
    textureQuality: settings.textureQuality,
    onProgress: (done, total) => report(id, 'textures', total ? done / total : 1),
  });

  report(id, settings.draco ? 'geometry' : 'write', 0);
  const output = await writeDocument(document, settings, loadDracoEncoder);
  report(id, 'write', 1);

  const breakdown: SizeBreakdown = {
    total: output.byteLength,
    textureBytes: textures.textureBytes,
    geometryBytes: Math.max(0, output.byteLength - textures.textureBytes - residualBytes),
    residualBytes,
    gpuBytes: textures.gpuBytes,
    measured: true,
  };

  if (wantBuffer) {
    // Copied out of the Document's buffer view so the transfer cannot detach
    // memory glTF-Transform still holds.
    const buffer = output.slice().buffer;
    post({ type: 'result', id, breakdown, buffer }, [buffer]);
  } else {
    post({ type: 'result', id, breakdown });
  }
}

self.onmessage = async (event: MessageEvent<OptimizeRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'open') {
      await open(request.id, request.buffer);
    } else {
      await run(request.id, request.settings, request.wantBuffer);
    }
  } catch (error) {
    post({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
