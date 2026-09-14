/**
 * Conversion worker: decode once, resample, then encode every requested format.
 *
 * The decode is why this is a worker at all. `EXRLoader.parse()` is one
 * monolithic synchronous call with no chunking hook that takes 0.6-3 s and
 * holds 250-600 MB; on the main thread it freezes the editor viewport's render
 * loop for its entire duration, and a "chunked" progress bar would sit at 0 %
 * through the freeze anyway.
 *
 * One worker per job, terminated afterwards. See `client.ts`. Cancellation is
 * `terminate()` for the same reason: a cooperative flag cannot be delivered
 * while the worker sits inside `parse()`.
 */

import { decodeHDR } from './decode-hdr.ts';
import { decodeSDR } from './decode-sdr.ts';
import { encodeWebP } from './encode-webp.ts';
import { encodeRGBE } from './rgbe.ts';
import { resample } from './resample.ts';
import type {
  ConvertPhase,
  ConvertWorkerRequest,
  ConvertWorkerResponse,
  LinearImage,
} from './types.ts';

const PHASE_LABEL: Record<ConvertPhase, string> = {
  decode: 'Bild wird dekodiert…',
  resample: 'Auflösung wird umgerechnet…',
  encode: 'Datei wird geschrieben…',
  mux: 'Gainmap wird berechnet…',
};

/**
 * Phase weights. The decode really is ~85 % of the wall time, so an evenly
 * divided bar would look broken.
 */
const DECODE_SPAN = 0.7;
const RESAMPLE_SPAN = 0.1;

function post(message: ConvertWorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

function report(phase: ConvertPhase, progress: number, label = PHASE_LABEL[phase]): void {
  post({ type: 'progress', progress: { phase, progress, label } });
}

self.onmessage = async (event: MessageEvent<ConvertWorkerRequest>) => {
  const { buffer, fileName, format, job, maxPixels } = event.data;
  try {
    report('decode', 0);
    let decoded: LinearImage;
    if (format === 'hdr' || format === 'exr') {
      decoded = await decodeHDR(buffer, format);
    } else if (format === 'sdr') {
      decoded = await decodeSDR(new Blob([buffer]), {
        onProgress: (fraction) => report('decode', fraction * DECODE_SPAN),
      });
    } else {
      // UltraHDRLoader needs DOMParser and a canvas element, neither of which
      // exists in a worker, so Ultra HDR cannot be a conversion *source* here.
      throw new Error('Ultra HDR kann nicht als Quelle umgerechnet werden.');
    }
    report('decode', DECODE_SPAN);

    if (decoded.width * decoded.height > maxPixels) {
      throw new Error(
        `${decoded.width} × ${decoded.height} ist zu groß, um im Browser umgerechnet zu werden.`,
      );
    }
    const source = { width: decoded.width, height: decoded.height };

    const image = resample(decoded, job.width, job.height, {
      onProgress: (fraction) => report('resample', DECODE_SPAN + fraction * RESAMPLE_SPAN),
    });
    // Release the decoded source before any encoder allocates.
    decoded.data = new Float32Array(0);

    const encodeSpan = (1 - DECODE_SPAN - RESAMPLE_SPAN) / Math.max(1, job.formats.length);
    let done = 0;

    for (const target of job.formats) {
      const base = DECODE_SPAN + RESAMPLE_SPAN + done * encodeSpan;
      if (target === 'hdr') {
        report('encode', base, 'Radiance .hdr wird geschrieben…');
        const encoded = encodeRGBE(image);
        const bytes = encoded.slice().buffer;
        post(
          {
            type: 'output',
            format: 'hdr',
            bytes,
            mimeType: 'image/vnd.radiance',
            width: image.width,
            height: image.height,
          },
          [bytes],
        );
      } else if (target === 'webp') {
        report('encode', base, 'WebP wird kodiert…');
        const { blob } = await encodeWebP(image, {
          quality: job.quality,
          onProgress: (fraction) => report('encode', base + fraction * encodeSpan, 'WebP wird kodiert…'),
        });
        const bytes = await blob.arrayBuffer();
        post(
          {
            type: 'output',
            format: 'webp',
            bytes,
            mimeType: 'image/webp',
            width: image.width,
            height: image.height,
          },
          [bytes],
        );
      } else {
        report('mux', base);
        // A copy, because the main thread takes ownership of the buffer while
        // any remaining formats still need the pixels.
        const copy = image.data.slice();
        post(
          {
            type: 'linear',
            data: copy.buffer as ArrayBuffer,
            width: image.width,
            height: image.height,
            maxComponent: image.maxComponent,
          },
          [copy.buffer as ArrayBuffer],
        );
      }
      done++;
    }

    post({ type: 'complete', source });
  } catch (error) {
    post({ type: 'error', message: (error as Error).message || 'Unbekannter Fehler' });
  }
};
