/**
 * The ceiling on how much this studio may ever store.
 *
 * Without one, "upload a model" is an unbounded write into a metered bucket:
 * nobody has to act in bad faith, a few colleagues dropping unoptimized 40 MB
 * exports is enough to turn a free tier into a monthly bill nobody decided on.
 * So every byte enters through `POST /api/sign` and every signature is issued
 * against a budget.
 *
 * The default deliberately sits under R2's 10 GB free allowance rather than at
 * some round number above it: the point of the limit is that the invoice stays
 * at zero, and the headroom absorbs the over- and under-counting below.
 */

export type QuotaEnv = {
  ASSETS: R2Bucket;
  /** Byte ceiling for the whole bucket. Set in wrangler.toml; see DEFAULT. */
  STORAGE_QUOTA_BYTES?: string;
};

export const DEFAULT_QUOTA_BYTES = 9 * 1024 * 1024 * 1024;

export function quotaBytes(env: QuotaEnv): number {
  const configured = Number(env.STORAGE_QUOTA_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_QUOTA_BYTES;
}

export type Usage = {
  /** Stored bytes plus everything signed for and not yet accounted as stored. */
  bytes: number;
  objects: number;
  /** When the stored figure was last measured against R2. */
  measuredAt: number;
};

/**
 * Summing the bucket costs one list call per 1000 objects, so it is cached per
 * isolate rather than run on every upload.
 */
const USAGE_TTL_MS = 5 * 60 * 1000;

type Measurement = { bytes: number; objects: number; measuredAt: number };

let measured: Measurement | null = null;

/**
 * Bytes we have signed for but cannot see in the bucket yet.
 *
 * A presigned PUT goes straight from the browser to R2, so the Worker never
 * observes the write. Without this, two people uploading 40 MB at the same
 * moment would both be measured against the same empty-looking bucket and both
 * be let through. Counting at signing time closes that.
 *
 * Each entry expires with the signature that created it: past that point the
 * upload either landed, and a measurement will find it, or the signature is
 * dead and it never can. Until then a landed upload is counted twice, which
 * refuses slightly too early rather than one byte too late. That is the
 * direction this should err in, and it is what the headroom under the free
 * allowance is for.
 */
let reservations: Array<{ bytes: number; expiresAt: number }> = [];

function reservedBytes(now: number): number {
  reservations = reservations.filter((entry) => entry.expiresAt > now);
  return reservations.reduce((total, entry) => total + entry.bytes, 0);
}

export async function bucketUsage(env: QuotaEnv, options: { force?: boolean } = {}): Promise<Usage> {
  const now = Date.now();

  if (options.force || !measured || now - measured.measuredAt >= USAGE_TTL_MS) {
    let bytes = 0;
    let objects = 0;
    let cursor: string | undefined;
    // No prefix: project documents and widget bundles occupy the same bucket
    // and the same invoice as the models do.
    do {
      const page = await env.ASSETS.list({ cursor, limit: 1000 });
      for (const object of page.objects) {
        bytes += object.size;
        objects += 1;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    measured = { bytes, objects, measuredAt: now };
  }

  // Reservations are added on top of the measurement rather than folded into
  // it, so a forced re-measurement cannot silently drop an upload that is still
  // streaming. Getting that wrong is what lets two concurrent uploads past a
  // ceiling neither of them would clear alone.
  return {
    bytes: measured.bytes + reservedBytes(now),
    objects: measured.objects,
    measuredAt: measured.measuredAt,
  };
}

/** Books bytes against the budget for as long as their signature can be used. */
export function reserve(bytes: number, ttlMs: number): void {
  reservations.push({ bytes, expiresAt: Date.now() + ttlMs });
}

/**
 * Drops the cached measurement, so the next read counts the bucket again.
 *
 * Called after a delete. Reservations are left alone: they are bytes that are
 * still on their way in and have nothing to do with what was just removed.
 */
export function invalidateUsage(): void {
  measured = null;
}
