/**
 * Main-thread side of the optimizer worker.
 *
 * Unlike the HDRI converter this is a *session*, not a one-shot call: the
 * worker keeps the parsed Document alive so changing a setting re-runs only
 * the passes that changed. The session owns the worker's lifetime — `close()`
 * terminates it, which is both the cancellation mechanism and the only
 * reliable way to release its heap.
 */

import type { OptimizeRequest, OptimizeResponse } from './worker.ts';
import type { OptimizeProgress, OptimizeSettings, SizeBreakdown, SourceAnalysis } from './types.ts';

export type RunOptions = {
  onProgress?: (progress: OptimizeProgress) => void;
  /** Ask for the encoded bytes. Skip it for a size measurement. */
  wantBuffer?: boolean;
};

export type RunResult = { breakdown: SizeBreakdown; notes: string[]; buffer?: ArrayBuffer };

type Pending = {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: OptimizeProgress) => void;
};

export class OptimizeSession {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  /**
   * Parses the GLB and returns its byte accounting. The buffer is transferred,
   * so the caller must not keep using it — a second copy of a 50 MB model on
   * the main thread is exactly what this avoids.
   */
  async open(buffer: ArrayBuffer): Promise<SourceAnalysis> {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<OptimizeResponse>) => this.handle(event.data);
    this.worker.onerror = (event) => this.failAll(new Error(event.message || 'Worker-Fehler'));

    return this.send({ type: 'open', id: 0, buffer }, [buffer]);
  }

  /** Applies the settings and reports the resulting size. */
  async run(settings: OptimizeSettings, options: RunOptions = {}): Promise<RunResult> {
    return this.send(
      { type: 'run', id: 0, settings, wantBuffer: options.wantBuffer ?? false },
      undefined,
      options.onProgress,
    );
  }

  /** Terminates the worker. Any in-flight run rejects. */
  close(): void {
    this.worker?.terminate();
    this.worker = null;
    this.failAll(new DOMException('Abgebrochen', 'AbortError'));
  }

  get isOpen(): boolean {
    return this.worker !== null;
  }

  private send<T>(
    request: OptimizeRequest,
    transfer?: Transferable[],
    onProgress?: (progress: OptimizeProgress) => void,
  ): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('Optimizer ist nicht geöffnet'));

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject, onProgress });
      worker.postMessage({ ...request, id }, transfer ?? []);
    });
  }

  private handle(message: OptimizeResponse): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;

    switch (message.type) {
      case 'progress':
        entry.onProgress?.({
          phase: message.phase,
          progress: message.progress,
          label: message.label,
        });
        break;
      case 'opened':
        this.pending.delete(message.id);
        entry.resolve(message.analysis as never);
        break;
      case 'result':
        this.pending.delete(message.id);
        entry.resolve({
          breakdown: message.breakdown,
          notes: message.notes,
          buffer: message.buffer,
        } as never);
        break;
      case 'error':
        this.pending.delete(message.id);
        entry.reject(new Error(message.message));
        break;
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}
