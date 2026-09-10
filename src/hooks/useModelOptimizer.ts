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

/**
 * The preview costs a real `writeBinary()` — Draco included — plus a full
 * decode into a second live scene, so it waits noticeably longer than the
 * number does. A size that lags by a second is annoying; a 3D rebuild that
 * fires mid-drag is what makes a dialog feel broken.
 */
const PREVIEW_DEBOUNCE_MS = 1500;

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
  /** Encoded GLB for the comparison view; null until one has been built. */
  preview: ArrayBuffer | null;
  /** Per-texture caveats from the last run, ready to render. */
  notes: string[];
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
export function useModelOptimizer(
  source: ArrayBuffer | null,
  options: { preview?: boolean } = {},
): ModelOptimizer {
  const previewEnabled = options.preview ?? false;
  const [status, setStatus] = useState<OptimizerStatus>('idle');
  const [error, setError] = useState('');
  const [settings, setSettingsState] = useState<OptimizeSettings>(DEFAULT_SETTINGS);
  const [analysis, setAnalysis] = useState<SourceAnalysis | null>(null);
  const [measured, setMeasured] = useState<SizeBreakdown | null>(null);
  const [progress, setProgress] = useState<OptimizeProgress | null>(null);
  const [preview, setPreview] = useState<ArrayBuffer | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

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
    setPreview(null);
    setNotes([]);

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
          const { breakdown, notes: runNotes } = await session.run(next, {
            onProgress: (value) => {
              if (tokenRef.current === token) setProgress(value);
            },
          });
          if (tokenRef.current !== token) return;
          setMeasured(breakdown);
          setNotes(runNotes);
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

  /**
   * Builds the GLB the comparison view renders. Requesting the bytes forces a
   * real write, so this runs on its own, slower timer and never on the path
   * that only needs a number.
   */
  const buildPreview = useCallback((next: OptimizeSettings) => {
    const session = sessionRef.current;
    if (!session?.isOpen) return;

    const token = tokenRef.current;
    queueRef.current = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (tokenRef.current !== token) return;
        try {
          const result = await session.run(next, { wantBuffer: true });
          if (tokenRef.current !== token) return;
          // A real write measures exactly, so it also supersedes the number.
          setMeasured(result.breakdown);
          setNotes(result.notes);
          setPreview(result.buffer ?? null);
        } catch {
          // A failed preview must not disturb the numbers or the confirm path.
        }
      });
  }, []);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
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
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      if (previewEnabled) {
        previewTimerRef.current = setTimeout(() => buildPreview(next), PREVIEW_DEBOUNCE_MS);
      }
    },
    [measure, buildPreview, previewEnabled],
  );

  // First measurement as soon as the document is open — no debounce, the user
  // has not touched anything yet.
  const openedRef = useRef(false);
  useEffect(() => {
    if (status === 'ready' && analysis && !openedRef.current) {
      openedRef.current = true;
      measure(settingsRef.current);
      if (previewEnabled) buildPreview(settingsRef.current);
    }
    if (!analysis) openedRef.current = false;
  }, [status, analysis, measure, buildPreview, previewEnabled]);

  /** Measured where available, calculated where not. */
  const size = useMemo<SizeBreakdown | null>(() => {
    if (measured) return measured;
    if (!analysis) return null;
    return estimateSize(analysis, settings);
  }, [measured, analysis, settings]);

  const finish = useCallback(async (): Promise<ArrayBuffer | null> => {
    const session = sessionRef.current;
    if (!session?.isOpen) return null;

    // Pending timers would otherwise fire more runs behind this one.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);

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
      setNotes(result.notes);
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

  return {
    status,
    error,
    settings,
    analysis,
    size,
    progress,
    preview,
    notes,
    setSettings,
    finish,
  };
}
