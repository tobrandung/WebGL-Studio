import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Converts an arbitrary label into a filesystem- and URL-safe slug.
 * Used to derive stable folder names from project names for widget hosting.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'projekt';
}

/**
 * Human-readable byte count with a German decimal comma. Centralises the
 * `(x / (1024 * 1024)).toFixed(2)` that was inlined in both upload dialogs.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024).toLocaleString('de-DE')} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1).replace('.', ',')} MB`;
  }
  // Only the team storage gets this far: models and HDRIs are refused long
  // before a gigabyte. Without it the quota reads as „9216,0 MB".
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace('.', ',')} GB`;
}
