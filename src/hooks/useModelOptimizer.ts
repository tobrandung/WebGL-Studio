import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OptimizeSession } from '@/lib/optimize/client';
import { estimateSize } from '@/lib/optimize/estimate';
import {
  DEFAULT_SETTINGS,
  type OptimizeProgress,
  type OptimizeSettings,
  type SizeBreakdown,
  type SourceAnalysis,
} from '@/lib/optimize/types';

/**
 * How long the settings have to sit still before the encoder is asked for a
 * real number. Short enough that letting go of a slider feels immediate, long
 * enough that dragging across it does not queue a run per step.
 */
const MEASURE_DEBOUNCE_MS = 600;

export type OptimizerStatus = 'idle' | 'opening' | 'ready' | 'measuring' | 'finishing';

export type ModelOptimizer = {
  status: OptimizerStatus;
  error: string;
  settings: OptimizeSettings;
  analysis: SourceAnalysis | null;
  /**
   * Current projection. `measured: false` means it is calculated and still
   * settling; the UI marks those with "≈".
   */
  size: SizeBreakdown | null;
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

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const setSettings = useCallback(
    (patch: Partial<OptimizeSettings>) => {
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      setSettingsState(next);
      // Drop the stale measurement right away so the UI falls back to the
      // estimate instead of showing a number for settings that no longer
      // apply, then let the encoder catch up once the dragging stops.
      setMeasured(null);
      tokenRef.current++;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => measure(next), MEASURE_DEBOUNCE_MS);
    },
    [measure],
  );

  // First measurement as soon as the document is open — no debounce, the user
  // has not touched anything yet.
  const openedRef = useRef(false);
  useEffect(() => {
    if (status === 'ready' && analysis && !openedRef.current) {
      openedRef.current = true;
      measure(settingsRef.current);
    }
    if (!analysis) openedRef.current = false;
  }, [status, analysis, measure]);

  /** Measured where available, calculated where not. */
  const size = useMemo<SizeBreakdown | null>(() => {
    if (measured) return measured;
    if (!analysis) return null;
    return estimateSize(analysis, settings);
  }, [measured, analysis, settings]);

  const finish = useCallback(async (): Promise<ArrayBuffer | null> => {
    const session = sessionRef.current;
    if (!session?.isOpen) return null;

    // A pending debounce would otherwise fire a second run behind this one.
    if (debounceRef.current) clearTimeout(debounceRef.current);

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

  return { status, error, settings, analysis, size, progress, setSettings, finish };
}
