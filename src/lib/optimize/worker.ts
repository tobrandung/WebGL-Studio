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
  jsonChunkBytes,
  readDocument,
  writeDocument,
} from './pipeline.ts';
import {
  captureTextureOriginals,
  createTextureCache,
  runTexturePass,
  type ResizedCanvasCache,
  type TextureOriginal,
} from './texture-pass.ts';
import type { OptimizeSettings, OptimizePhase, SourceAnalysis, SizeBreakdown } from './types.ts';

export type OptimizeRequest =
  | { type: 'open'; id: number; buffer: ArrayBuffer }
  | { type: 'run'; id: number; settings: OptimizeSettings; wantBuffer: boolean };

export type OptimizeResponse =
  | { type: 'opened'; id: number; analysis: SourceAnalysis }
  | { type: 'progress'; id: number; phase: OptimizePhase; progress: number; label: string }
  | {
      type: 'result';
      id: number;
      breakdown: SizeBreakdown;
      notes: string[];
      buffer?: ArrayBuffer;
    }
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
let textureCache: ResizedCanvasCache = createTextureCache();

/**
 * What the last real `writeBinary()` produced, and under which geometry
 * settings. Draco encodes during the write — not as a Document mutation — so
 * a full write costs seconds on a large mesh. As long as the geometry
 * settings have not moved, that measurement still holds and a texture-only
 * change can be reported as `new texture bytes + this`. The error is the few
 * bytes of JSON and padding that shift with the texture URIs, well under 1 %.
 */
let lastWrite: { draco: boolean; geometryBytes: number; residualBytes: number } | null = null;

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

  report(id, 'clean', 0);
  await cleanDocument(document);
  // Captured after cleaning so dedup has already collapsed duplicate images —
  // the pass then never encodes the same picture twice.
  originals = captureTextureOriginals(document);
  textureCache = createTextureCache();
  lastWrite = null;

  post({ type: 'opened', id, analysis });
}

/**
 * Collapses per-texture entries into one line per cause. Twenty-six textures
 * with the same caveat is one thing to know, not twenty-six; the names are
 * only worth listing while there are few enough to read.
 */
function summarise(entries: { name: string; reason: string }[], suffix: string): string[] {
  const byReason = new Map<string, string[]>();
  for (const entry of entries) {
    const names = byReason.get(entry.reason) ?? [];
    names.push(entry.name);
    byReason.set(entry.reason, names);
  }

  return [...byReason].map(([reason, names]) => {
    const unique = [...new Set(names)];
    const subject =
      names.length === 1
        ? unique[0]
        : `${names.length} Texturen (${unique.slice(0, 3).join(', ')}${unique.length > 3 ? ', …' : ''})`;
    return `${subject}: ${reason}${suffix}`;
  });
}

async function run(id: number, settings: OptimizeSettings, wantBuffer: boolean): Promise<void> {
  if (!document || !analysis) throw new Error('Kein Modell geöffnet');

  report(id, 'textures', 0);
  const textures = await runTexturePass(
    document,
    originals,
    {
      textureFormat: settings.textureFormat,
      maxTextureSize: settings.maxTextureSize,
      textureQuality: settings.textureQuality,
      onProgress: (done, total) => report(id, 'textures', total ? done / total : 1),
    },
    textureCache,
  );

  // Skip the write when only the textures moved and the caller just wants a
  // number: re-serialising would re-run Draco over every primitive for a
  // result we can already account for exactly.
  const notes = summarise(textures.skipped, ' — bleibt unverändert').concat(
    summarise(textures.warnings, ''),
  );

  const canReuseGeometry = !wantBuffer && lastWrite?.draco === settings.draco;
  if (canReuseGeometry && lastWrite) {
    report(id, 'write', 1);
    post({
      type: 'result',
      id,
      notes,
      breakdown: {
        total: textures.textureBytes + lastWrite.geometryBytes + lastWrite.residualBytes,
        textureBytes: textures.textureBytes,
        geometryBytes: lastWrite.geometryBytes,
        residualBytes: lastWrite.residualBytes,
        gpuBytes: textures.gpuBytes,
        measured: true,
      },
    });
    return;
  }

  report(id, settings.draco ? 'geometry' : 'write', 0);
  const output = await writeDocument(document, settings, loadDracoEncoder);
  report(id, 'write', 1);

  const residualBytes = jsonChunkBytes(output);
  const geometryBytes = Math.max(0, output.byteLength - textures.textureBytes - residualBytes);
  lastWrite = { draco: settings.draco, geometryBytes, residualBytes };

  const breakdown: SizeBreakdown = {
    total: output.byteLength,
    textureBytes: textures.textureBytes,
    geometryBytes,
    residualBytes,
    gpuBytes: textures.gpuBytes,
    measured: true,
  };

  if (wantBuffer) {
    // Copied out of the Document's buffer view so the transfer cannot detach
    // memory glTF-Transform still holds.
    const buffer = output.slice().buffer;
    post({ type: 'result', id, breakdown, notes, buffer }, [buffer]);
  } else {
    post({ type: 'result', id, breakdown, notes });
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
