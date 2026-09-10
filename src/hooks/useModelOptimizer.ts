import { useCallback, useEffect, useRef, useState } from 'react';
import { OptimizeSession } from '@/lib/optimize/client';
import {
  DEFAULT_SETTINGS,
  type OptimizeProgress,
  type OptimizeSettings,
  type SizeBreakdown,
  type SourceAnalysis,
} from '@/lib/optimize/types';

export type OptimizerStatus = 'idle' | 'opening' | 'ready' | 'measuring' | 'finishing';

export type ModelOptimizer = {
  status: OptimizerStatus;
  error: string;
  settings: OptimizeSettings;
  analysis: SourceAnalysis | null;
  /** Result of the last completed run, or null before the first one. */
  measured: SizeBreakdown | null;
  progress: OptimizeProgress | null;
  setSettings: (patch: Partial<OptimizeSettings>) => void;
  /** Runs once more and hands back the encoded GLB. */
  finish: () => Promise<ArrayBuffer | null>;
};

/**
 * Drives one optimize session.
 *
 * The worker keeps the parsed Document alive, so a settings change costs only
 * the passes that actually changed rather than another parse. Runs are
 * serialised — a run started while one is in flight waits for it, and only the
 * newest settings are ever measured, so dragging a slider cannot queue up a
 * backlog of stale jobs.
 */
export function useModelOptimizer(source: ArrayBuffer | null): ModelOptimizer {
  const [status, setStatus] = useState<OptimizerStatus>('idle');
  const [error, setError] = useState('');
  const [settings, setSettingsState] = useState<OptimizeSettings>(DEFAULT_SETTINGS);
  const [analysis, setAnalysis] = useState<SourceAnalysis | null>(null);
  const [measured, setMeasured] = useState<SizeBreakdown | null>(null);
  const [progress, setProgress] = useState<OptimizeProgress | null>(null);

  const sessionRef = useRef<OptimizeSession | null>(null);
  /** Guards against a superseded run resolving after a newer one. */
  const tokenRef = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  /** Serialises runs: the worker holds one Document and cannot interleave. */
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!source) return;

    const session = new OptimizeSession();
    sessionRef.current = session;
    const token = ++tokenRef.current;
    setStatus('opening');
    setError('');
    setMeasured(null);
    setAnalysis(null);

    void (async () => {
      try {
        const result = await session.open(source);
        if (tokenRef.current !== token) return;
        setAnalysis(result);
        setStatus('ready');
      } catch (cause) {
        if (tokenRef.current !== token) return;
        if ((cause as Error).name === 'AbortError') return;
        setStatus('idle');
        setError(`Modell konnte nicht gelesen werden: ${(cause as Error).message}`);
      }
    })();

    return () => {
      tokenRef.current++;
      session.close();
      sessionRef.current = null;
    };
  }, [source]);

  const measure = useCallback((next: OptimizeSettings) => {
    const session = sessionRef.current;
    if (!session?.isOpen) return;

    const token = ++tokenRef.current;
    setStatus('measuring');
    setError('');

    queueRef.current = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        // A newer change arrived while this one waited — drop it rather than
        // measuring settings the user has already moved past.
        if (tokenRef.current !== token) return;
        try {
          const { breakdown } = await session.run(next, {
            onProgress: (value) => {
              if (tokenRef.current === token) setProgress(value);
            },
          });
          if (tokenRef.current !== token) return;
          setMeasured(breakdown);
          setProgress(null);
          setStatus('ready');
        } catch (cause) {
          if (tokenRef.current !== token) return;
          if ((cause as Error).name === 'AbortError') return;
          setProgress(null);
          setStatus('ready');
          setError(`Optimieren fehlgeschlagen: ${(cause as Error).message}`);
        }
      });
  }, []);

  const setSettings = useCallback(
    (patch: Partial<OptimizeSettings>) => {
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      setSettingsState(next);
      measure(next);
    },
    [measure],
  );

  // First measurement as soon as the document is open.
  const openedRef = useRef(false);
  useEffect(() => {
    if (status === 'ready' && analysis && !openedRef.current) {
      openedRef.current = true;
      measure(settingsRef.current);
    }
    if (!analysis) openedRef.current = false;
  }, [status, analysis, measure]);

  const finish = useCallback(async (): Promise<ArrayBuffer | null> => {
    const session = sessionRef.current;
    if (!session?.isOpen) return null;

    const token = ++tokenRef.current;
    setStatus('finishing');
    setError('');

    try {
      const result = await queueRef.current
        .catch(() => undefined)
        .then(() =>
          session.run(settingsRef.current, {
            wantBuffer: true,
            onProgress: (value) => {
              if (tokenRef.current === token) setProgress(value);
            },
          }),
        );
      if (tokenRef.current !== token) return null;
      setMeasured(result.breakdown);
      setProgress(null);
      setStatus('ready');
      return result.buffer ?? null;
    } catch (cause) {
      if (tokenRef.current !== token) return null;
      setProgress(null);
      setStatus('ready');
      setError(`Optimieren fehlgeschlagen: ${(cause as Error).message}`);
      return null;
    }
  }, []);

  return { status, error, settings, analysis, measured, progress, setSettings, finish };
}
