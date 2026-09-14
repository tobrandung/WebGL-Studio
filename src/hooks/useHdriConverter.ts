import { useCallback, useEffect, useRef, useState } from 'react';
import { convertEnvironment, probeEnvironmentFile, type EnvironmentProbe } from '@/lib/hdri/client';
import { isSupportedEnvironmentFile } from '@/lib/hdri/format';
import {
  availableFormats,
  parseTargetKey,
  recommendTarget,
  targetKey,
  type Recommendation,
  type TargetKey,
} from '@/lib/hdri/targets';
import type { ConvertOutput, ConvertProgress } from '@/lib/hdri/types';

export type ConverterStatus = 'idle' | 'sniffing' | 'ready' | 'converting';

export type HdriConverter = {
  file: File | null;
  probe: EnvironmentProbe | null;
  status: ConverterStatus;
  error: string;
  recommendation: Recommendation | null;
  /** Currently highlighted output, cached or in flight. */
  selected: TargetKey | null;
  progress: ConvertProgress | null;
  variants: ReadonlyMap<TargetKey, ConvertOutput>;
  selectFile: (file: File) => void;
  selectTarget: (key: TargetKey) => void;
  reset: () => void;
};

/**
 * Drives one HDRI conversion at a time.
 *
 * A job encodes every offered format at one resolution from a single decode, so
 * switching format is instant from the cache and only a resolution change pays
 * for another decode. That asymmetry is deliberate: comparing formats is the
 * comparison users actually make.
 */
export function useHdriConverter(showBackground: boolean): HdriConverter {
  const [file, setFile] = useState<File | null>(null);
  const [probe, setProbe] = useState<EnvironmentProbe | null>(null);
  const [status, setStatus] = useState<ConverterStatus>('idle');
  const [error, setError] = useState('');
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [selected, setSelected] = useState<TargetKey | null>(null);
  const [progress, setProgress] = useState<ConvertProgress | null>(null);
  const [variants, setVariants] = useState<ReadonlyMap<TargetKey, ConvertOutput>>(new Map());

  const jobRef = useRef<AbortController | null>(null);
  /** Guards against a superseded job resolving after a newer one. */
  const tokenRef = useRef(0);
  const variantsRef = useRef(variants);
  variantsRef.current = variants;

  const cancel = useCallback(() => {
    jobRef.current?.abort();
    jobRef.current = null;
    tokenRef.current++;
  }, []);

  const reset = useCallback(() => {
    cancel();
    setFile(null);
    setProbe(null);
    setStatus('idle');
    setError('');
    setRecommendation(null);
    setSelected(null);
    setProgress(null);
    setVariants(new Map());
  }, [cancel]);

  useEffect(() => cancel, [cancel]);

  const runJob = useCallback(
    async (source: File, info: EnvironmentProbe, key: TargetKey) => {
      cancel();
      const controller = new AbortController();
      jobRef.current = controller;
      const token = ++tokenRef.current;

      const { width } = parseTargetKey(key);
      setSelected(key);
      setStatus('converting');
      setError('');
      setProgress({ phase: 'decode', progress: 0, label: 'Bild wird dekodiert…' });

      try {
        const result = await convertEnvironment(
          source,
          { width, height: Math.max(1, Math.round(width / 2)), formats: availableFormats(info.format) },
          {
            signal: controller.signal,
            onProgress: (next) => {
              if (tokenRef.current === token) setProgress(next);
            },
          },
        );
        if (tokenRef.current !== token) return;
        const merged = new Map(variantsRef.current);
        for (const output of result.outputs) merged.set(targetKey(output.format, output.width), output);
        setVariants(merged);
        setStatus('ready');
        setProgress(null);
      } catch (cause) {
        if (tokenRef.current !== token) return;
        if ((cause as Error).name === 'AbortError') return;
        // Ready, not failed: "Original übernehmen" has to stay available on
        // every path, so a decode or encode failure must not dead-end the flow.
        setStatus('ready');
        setProgress(null);
        setError(
          `Umrechnen fehlgeschlagen: ${(cause as Error).message} Du kannst die Datei trotzdem unverändert übernehmen.`,
        );
      }
    },
    [cancel],
  );

  const selectFile = useCallback(
    (next: File) => {
      cancel();
      setVariants(new Map());
      setProgress(null);
      setSelected(null);
      setRecommendation(null);
      setError('');

      if (!isSupportedEnvironmentFile(next.name)) {
        setFile(null);
        setProbe(null);
        setStatus('idle');
        setError('Nicht unterstütztes Format. Erlaubt: .hdr, .exr, .jpg, .png, .webp');
        return;
      }

      setFile(next);
      setProbe(null);
      setStatus('sniffing');

      const token = ++tokenRef.current;
      void (async () => {
        try {
          const info = await probeEnvironmentFile(next);
          if (tokenRef.current !== token) return;
          setProbe(info);
          setStatus('ready');
          if (!info.width || !info.height) {
            setError(
              'Die Bildabmessungen konnten nicht gelesen werden. Umrechnen ist nicht möglich. Du kannst die Datei trotzdem unverändert übernehmen.',
            );
            return;
          }
          const advice = recommendTarget({
            sourceFormat: info.format,
            sourceWidth: info.width,
            showBackground,
          });
          setRecommendation(advice);
          if (info.tooLargeToConvert) {
            setError(
              `${info.width} × ${info.height} ist zu groß, um im Browser umgerechnet zu werden. Nutze "npm run presets:hdri" oder übernimm das Original unverändert.`,
            );
            return;
          }
          void runJob(next, info, advice.key);
        } catch (cause) {
          if (tokenRef.current !== token) return;
          setStatus('ready');
          setError(
            `Die Datei konnte nicht gelesen werden: ${(cause as Error).message} Du kannst sie trotzdem unverändert übernehmen.`,
          );
        }
      })();
    },
    [cancel, runJob, showBackground],
  );

  const selectTarget = useCallback(
    (key: TargetKey) => {
      if (!file || !probe) return;
      if (variantsRef.current.has(key)) {
        setSelected(key);
        setError('');
        return;
      }
      void runJob(file, probe, key);
    },
    [file, probe, runJob],
  );

  return {
    file,
    probe,
    status,
    error,
    recommendation,
    selected,
    progress,
    variants,
    selectFile,
    selectTarget,
    reset,
  };
}
