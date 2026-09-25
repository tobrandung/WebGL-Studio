/**
 * Main-thread runner for a conversion job: probes the file, drives the worker,
 * and finishes the Ultra HDR path itself (that encoder needs a WebGLRenderer,
 * which a worker has no clean way to provide).
 */

import { MAX_DECODE_PIXELS } from './decode-hdr.ts';
import { probeSDR } from './decode-sdr.ts';
import { extensionForFormat, extensionOf, sniffEnvironmentFormat, slugifyName } from './format.ts';
import { probeEquirect } from './pipeline.ts';
import type {
  ConvertJob,
  ConvertJobResult,
  ConvertOutput,
  ConvertProgress,
  ConvertWorkerRequest,
  ConvertWorkerResponse,
  EnvironmentFormat,
  LinearImageF32,
  TargetFormat,
} from './types.ts';

/** Enough bytes for any Radiance or EXR header. */
const HEAD_BYTES = 1 << 16;

export type EnvironmentProbe = {
  format: EnvironmentFormat;
  bytes: number;
  width: number;
  height: number;
  /** Set when the container uses a variant the decoder treats differently. */
  note?: string;
  /** The source exceeds what a browser tab can decode; only the CLI can. */
  tooLargeToConvert: boolean;
};

/**
 * Reads format and dimensions cheaply. From the file header for HDR/EXR, via
 * `createImageBitmap` for the rest. Deliberately never decodes pixels: a 16k
 * source has to get its size warning *before* anything allocates a gigabyte,
 * which is exactly the case the warning exists for.
 */
export async function probeEnvironmentFile(file: File): Promise<EnvironmentProbe> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const format = sniffEnvironmentFormat(head, file.name);

  let width = 0;
  let height = 0;
  let note: string | undefined;

  const fromHeader = probeEquirect(head, file.name);
  if (fromHeader) {
    width = fromHeader.width;
    height = fromHeader.height;
    note = fromHeader.note;
  } else {
    // JPEG/PNG/WebP, and Ultra HDR via its SDR base image.
    const size = await probeSDR(file).catch(() => ({ width: 0, height: 0 }));
    width = size.width;
    height = size.height;
  }

  return {
    format,
    bytes: file.size,
    width,
    height,
    note,
    tooLargeToConvert: width * height > MAX_DECODE_PIXELS,
  };
}

/** `studio_small_08_4k.exr` + hdr@1024 -> `studio-small-08-1k.hdr`. */
export function outputFileName(sourceName: string, format: EnvironmentFormat, width: number): string {
  const extension = extensionOf(sourceName);
  const stem = (extension ? sourceName.slice(0, -extension.length) : sourceName).replace(/[_-]\d+k$/i, '');
  const k = width / 1024;
  const tier = Number.isInteger(k) ? `${k}k` : Number.isInteger(k * 2) ? `${k.toFixed(1)}k` : `${width}px`;
  return `${slugifyName(stem)}-${tier}${extensionForFormat(format)}`;
}

/** A target's on-disk format. WebP output is just an SDR image. */
export function storedFormat(target: TargetFormat): EnvironmentFormat {
  return target === 'webp' ? 'sdr' : target;
}

export type ConvertOptions = {
  onProgress?: (progress: ConvertProgress) => void;
  signal?: AbortSignal;
};

/**
 * Runs one conversion job: the worker decodes and encodes the Radiance and WebP
 * outputs, and the Ultra HDR output finishes here because its encoder needs a
 * WebGLRenderer.
 */
export async function convertEnvironment(
  file: File,
  job: ConvertJob,
  options: ConvertOptions = {},
): Promise<ConvertJobResult> {
  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer.slice(0, Math.min(buffer.byteLength, HEAD_BYTES)));
  const sourceFormat = sniffEnvironmentFormat(head, file.name);

  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const outputs: ConvertOutput[] = [];
  /** Ultra HDR encodes are queued so the worker is never blocked waiting. */
  const pending: Array<Promise<void>> = [];
  let sourceSize = { width: 0, height: 0 };

  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        worker.terminate();
        reject(new DOMException('Abgebrochen', 'AbortError'));
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });

      worker.onmessage = (event: MessageEvent<ConvertWorkerResponse>) => {
        const data = event.data;
        switch (data.type) {
          case 'progress':
            options.onProgress?.(data.progress);
            break;
          case 'output':
            outputs.push({
              format: data.format,
              blob: new Blob([data.bytes], { type: data.mimeType }),
              fileName: outputFileName(file.name, storedFormat(data.format), data.width),
              width: data.width,
              height: data.height,
            });
            break;
          case 'linear': {
            const image: LinearImageF32 = {
              data: new Float32Array(data.data),
              dataType: 'float32',
              components: 3,
              width: data.width,
              height: data.height,
              isHDR: true,
              maxComponent: data.maxComponent,
            };
            pending.push(
              // Loaded on first use: the encoder brings the classic
              // WebGLRenderer (gainmap-js has no WebGPU encode path), which
              // nothing else in the app needs any more.
              import('./encode-ultrahdr.ts').then(({ encodeUltraHDR }) => encodeUltraHDR(image, {
                quality: job.quality,
                onProgress: (fraction) =>
                  options.onProgress?.({
                    phase: 'mux',
                    progress: 0.9 + 0.1 * fraction,
                    label: 'Gainmap wird berechnet…',
                  }),
              }).then((blob) => {
                outputs.push({
                  format: 'ultrahdr',
                  blob,
                  fileName: outputFileName(file.name, 'ultrahdr', image.width),
                  width: image.width,
                  height: image.height,
                });
              })),
            );
            break;
          }
          case 'complete':
            sourceSize = data.source;
            resolve();
            break;
          case 'error':
            reject(new Error(data.message));
            break;
        }
      };
      worker.onerror = (event) => reject(new Error(event.message || 'Worker-Fehler'));

      const request: ConvertWorkerRequest = {
        buffer,
        fileName: file.name,
        format: sourceFormat,
        job,
        maxPixels: MAX_DECODE_PIXELS,
      };
      // Transferred, not copied: the main thread must not hold a second copy of
      // a 70 MB source.
      worker.postMessage(request, [buffer]);
    });

    await Promise.all(pending);
    return {
      outputs,
      source: { format: sourceFormat, width: sourceSize.width, height: sourceSize.height, bytes: file.size },
    };
  } finally {
    // Immediate and unconditional, which is the only way to stop a worker that
    // is inside a synchronous parse. And it frees its whole heap at once.
    worker.terminate();
  }
}
