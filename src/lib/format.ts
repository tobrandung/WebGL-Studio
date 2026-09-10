/**
 * Saving as a percentage. Kept off 100 % with a decimal, because a 72 MB source
 * down to 30 KB rounds to "−100 %", which reads as "nothing left" rather than
 * as the win it is.
 */
export function formatSaving(resultBytes: number, sourceBytes: number): string {
  if (!sourceBytes) return '0 %';
  const saving = (1 - resultBytes / sourceBytes) * 100;
  // Floored, not rounded, so an extreme saving reports "99,9 %" rather than the
  // nonsensical-looking "100 %".
  const rounded = saving > 99 ? (Math.floor(saving * 10) / 10).toFixed(1) : String(Math.round(saving));
  return `${rounded.replace('.', ',')} %`;
}
