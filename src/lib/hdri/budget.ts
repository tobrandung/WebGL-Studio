/**
 * Web-weight budget for an environment map. Pure.
 *
 * The environment is a *blocking* asset: `applyEnvironment` cannot run until the
 * whole file has arrived (none of the HDR decoders have a progressive path), so
 * its byte count converts directly into time-to-first-correct-frame. And it is
 * shipped with the widget, so it lands on every visitor of the embedding page.
 */

/** Under this the environment is not what makes a page feel slow. */
export const BUDGET_GOOD = 1024 * 1024;

/**
 * Above this the HDRI becomes the largest asset in the embed (the widget bundle
 * is ~650 KB and a compressed GLB typically 2-5 MB) and starts to dominate load
 * time rather than contribute to it.
 */
export const BUDGET_OK = 3 * 1024 * 1024;

/** jsDelivr refuses files above this with HTTP 403. See ExportDialog. */
export const CDN_LIMIT = 20 * 1024 * 1024;

export type BudgetZone = 'good' | 'ok' | 'large' | 'over-cdn';

export function budgetZone(bytes: number): BudgetZone {
  if (bytes <= BUDGET_GOOD) return 'good';
  if (bytes <= BUDGET_OK) return 'ok';
  if (bytes <= CDN_LIMIT) return 'large';
  return 'over-cdn';
}

export const ZONE_LABEL: Record<BudgetZone, string> = {
  good: 'gut',
  ok: 'ok',
  large: 'zu groß',
  'over-cdn': 'über CDN-Limit',
};

/** Width each zone occupies on the bar, summing to 1. */
export const ZONE_WIDTH: Record<BudgetZone, number> = {
  good: 0.4,
  ok: 0.3,
  large: 0.25,
  'over-cdn': 0.05,
};

/**
 * Position of `bytes` along the bar, 0..1. Piecewise linear per zone rather
 * than linear overall: a linear 0-20 MiB axis would squeeze the entire
 * decision-relevant range into the first 15 % of the width, and a 94 MB source
 * would push everything off the end.
 */
export function budgetPosition(bytes: number): number {
  if (bytes <= BUDGET_GOOD) return (bytes / BUDGET_GOOD) * ZONE_WIDTH.good;
  if (bytes <= BUDGET_OK) {
    return ZONE_WIDTH.good + ((bytes - BUDGET_GOOD) / (BUDGET_OK - BUDGET_GOOD)) * ZONE_WIDTH.ok;
  }
  if (bytes <= CDN_LIMIT) {
    return (
      ZONE_WIDTH.good +
      ZONE_WIDTH.ok +
      ((bytes - BUDGET_OK) / (CDN_LIMIT - BUDGET_OK)) * ZONE_WIDTH.large
    );
  }
  const over = Math.min(1, (bytes - CDN_LIMIT) / CDN_LIMIT);
  return 1 - ZONE_WIDTH['over-cdn'] + over * ZONE_WIDTH['over-cdn'];
}

/**
 * Resolution thresholds, which matter independently of file size.
 *
 * Two reasons: an equirect costs `w * h * 8` bytes of VRAM as half-float RGBA
 * (8192x4096 = 256 MB, 16384x8192 = 1.07 GB. Past `MAX_TEXTURE_SIZE` on many
 * mobile GPUs, where the environment then renders black), and
 * `PMREMGenerator.fromEquirectangular` filters into a fixed 256-px-per-face
 * cubemap, so reflection quality saturates around 1024x512. Everything above
 * that is paid for exclusively by a visible background dome.
 */
export const RESOLUTION_IDEAL = 1024;
export const RESOLUTION_NOTE = 2048;
export const RESOLUTION_WARN = 4096;
export const RESOLUTION_SEVERE = 8192;

/** Bytes of GPU memory an equirect of this size occupies as half-float RGBA. */
export function textureBytes(width: number, height: number): number {
  return width * height * 8;
}
