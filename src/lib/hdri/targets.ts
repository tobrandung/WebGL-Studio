/** The format x resolution matrix the converter offers, and what to recommend. */

import type { EnvironmentFormat, TargetFormat } from './types.ts';

export const TARGET_FORMATS: readonly TargetFormat[] = ['hdr', 'ultrahdr', 'webp'];

/** Offered widths, filtered against the source so nothing is ever upscaled. */
export const TARGET_WIDTHS: readonly number[] = [1024, 2048, 4096];

export type TargetKey = `${TargetFormat}@${number}`;

export function targetKey(format: TargetFormat, width: number): TargetKey {
  return `${format}@${width}`;
}

export function parseTargetKey(key: TargetKey): { format: TargetFormat; width: number } {
  const [format, width] = key.split('@');
  return { format: format as TargetFormat, width: Number(width) };
}

export function availableWidths(sourceWidth: number): number[] {
  const widths = TARGET_WIDTHS.filter((width) => width <= sourceWidth);
  // A source narrower than 1024 still gets one option: its own width.
  return widths.length ? widths : [Math.max(2, sourceWidth)];
}

/**
 * Formats worth offering for a given source. An SDR upload has no range to
 * preserve, so `.hdr` and Ultra HDR would only make the file bigger for nothing.
 */
export function availableFormats(sourceFormat: EnvironmentFormat): TargetFormat[] {
  return sourceFormat === 'sdr' ? ['webp'] : [...TARGET_FORMATS];
}

export const FORMAT_LABEL: Record<TargetFormat, string> = {
  hdr: 'Radiance .hdr',
  ultrahdr: 'Ultra HDR JPEG',
  webp: 'WebP (SDR)',
};

export const FORMAT_HINT: Record<TargetFormat, string> = {
  hdr: 'Echter HDR-Bereich, wird von jedem Widget-Stand gelesen. Die sichere Wahl, aber die größte Datei.',
  ultrahdr:
    'Echter HDR-Bereich bei etwa einem Zwanzigstel der Dateigröße. Braucht einen neu gebauten Widget-Build. Bereits eingebettete Widgets zeigen sonst nur die flache SDR-Basis.',
  webp: 'Kleinste Datei, aber ohne HDR-Bereich: Lichter werden abgeschnitten, Spiegelungen wirken flacher. Gut für unscharfe Hintergründe.',
};

export type RecommendationInput = {
  sourceFormat: EnvironmentFormat;
  sourceWidth: number;
  /** Whether the environment is (or will be) shown as a visible dome. */
  showBackground: boolean;
};

export type Recommendation = {
  key: TargetKey;
  reason: string;
  /** A second option worth naming, with the trade-off spelled out. */
  alternative?: {
    key: TargetKey;
    /** Rendered as `<reason> (<measured size>).` */
    reason: string;
    /** Appended after the size, when there is a string attached. */
    caveat?: string;
  };
};

/**
 * What to preselect.
 *
 * Reflection-only (the default for a new environment) gets `.hdr` at 1024x512:
 * the only format every widget build ever shipped decodes at full HDR fidelity,
 * at the resolution where PMREM saturates.
 *
 * A visible background needs 2K to look sharp, and `.hdr` at 2K is 5-7 MB, and
 * recommending that would contradict the entire point of this dialog. Ultra HDR
 * is the only format that delivers 2K *with* HDR range inside the budget, so
 * that is the recommendation there, caveat and all.
 */
export function recommendTarget(input: RecommendationInput): Recommendation {
  const widths = availableWidths(input.sourceWidth);
  const pick = (preferred: number) =>
    widths.includes(preferred) ? preferred : widths[widths.length - 1];

  if (input.sourceFormat === 'sdr') {
    const width = pick(2048);
    return {
      key: targetKey('webp', width),
      reason: `Empfohlen: WebP, ${width} × ${width / 2}. Die Quelle ist ohnehin ein SDR-Bild, HDR-Formate würden sie nur größer machen.`,
    };
  }

  if (input.showBackground) {
    const width = pick(2048);
    return {
      key: targetKey('ultrahdr', width),
      reason: `Empfohlen: Ultra HDR, ${width} × ${width / 2}, weil diese Umgebung als sichtbarer Hintergrund läuft. Als .hdr wären das 5–7 MB.`,
      // Same resolution as the recommendation, so its measured size comes out
      // of the same job. And seeing what .hdr costs at 2K is precisely the
      // argument for Ultra HDR.
      alternative: {
        key: targetKey('hdr', width),
        reason: `Sicherer, weil jeder Widget-Build es liest, aber deutlich größer: .hdr, ${width} × ${width / 2}`,
      },
    };
  }

  return {
    key: targetKey('hdr', 1024),
    reason: 'Empfohlen: .hdr, 1024 × 512. Reicht für Spiegelungen und läuft mit jedem Widget-Build.',
    // Deliberately the same resolution as the recommendation: one job encodes
    // every format at one resolution, so this size is already measured, and a
    // pure format comparison is the one users actually want.
    alternative: {
      key: targetKey('ultrahdr', 1024),
      reason: 'Gleiche Dynamik, viel kleiner: Ultra HDR',
      caveat: 'Dafür muss der Widget-Build neu erzeugt und mit hochgeladen werden.',
    },
  };
}
