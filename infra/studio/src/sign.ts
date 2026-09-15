import { AwsV4Signer } from 'aws4fetch';
import {
  isValidAssetKey,
  checksumMatchesKey,
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  IMMUTABLE_CACHE_CONTROL,
} from '../../shared/asset-key.ts';
import { bucketUsage, quotaBytes, reserve, type QuotaEnv } from './quota.ts';

export type SignEnv = QuotaEnv & {
  ASSETS: R2Bucket;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** Public base URL of the delivery Worker, e.g. https://web3d-cdn.x.workers.dev */
  CDN_BASE: string;
};

const SIGNATURE_TTL_SECONDS = 300;

type SignRequest = { key?: unknown; contentType?: unknown; size?: unknown; checksum?: unknown };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * German byte count for an error the user reads. Switches to GB only once the
 * number is actually gigabytes, so a nearly empty bucket does not report
 * itself as "0,0 von 0,0 GB".
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
}

/**
 * `GET /api/usage` — how full the bucket is, and how full it is allowed to get.
 *
 * Exists so the dashboard can show the budget before someone runs into it. A
 * limit nobody can see is indistinguishable from a broken upload.
 */
export async function handleUsage(env: SignEnv): Promise<Response> {
  const usage = await bucketUsage(env);
  return json(200, {
    usedBytes: usage.bytes,
    quotaBytes: quotaBytes(env),
    objects: usage.objects,
    measuredAt: usage.measuredAt,
  });
}

export function publicUrl(env: SignEnv, key: string): string {
  return `${env.CDN_BASE.replace(/\/$/, '')}/${key}`;
}

/**
 * `GET /api/sign?key=…` — is this content hash already stored, and what is its
 * public URL?
 *
 * Content-addressed keys make re-uploads pointless: the same bytes always
 * produce the same key, so a hit means the file is already served. Returning
 * the URL alongside the answer means a skipped upload costs exactly one
 * request — re-exporting an unchanged project transfers nothing.
 */
export async function handleExists(request: Request, env: SignEnv): Promise<Response> {
  const key = new URL(request.url).searchParams.get('key') ?? '';
  if (!isValidAssetKey(key)) return json(400, { error: 'Ungültiger Asset-Key.' });
  const head = await env.ASSETS.head(key);
  return json(200, {
    exists: head !== null,
    size: head?.size ?? null,
    publicUrl: publicUrl(env, key),
  });
}

/**
 * `POST /api/sign` — hands back a short-lived presigned PUT so the browser
 * uploads straight into R2.
 *
 * The upload deliberately does not pass through this Worker: that avoids the
 * 100 MB request-body limit of the free plan, spares us proxying tens of
 * megabytes through a CPU-metered isolate, and means a failed upload costs one
 * retry rather than a re-read of the whole file.
 *
 * Content-Type, Cache-Control, Content-Length and the SHA-256 checksum are all
 * part of the signature, so the client cannot store a file that is bigger,
 * differently typed, less cacheable, or simply *other* than what was approved
 * here — R2 hashes the body itself and refuses a mismatch. Because we also
 * require the checksum to agree with the key, an authenticated caller cannot
 * park unrelated bytes under a name someone else links to.
 */
export async function handleSign(request: Request, env: SignEnv): Promise<Response> {
  let body: SignRequest;
  try {
    body = (await request.json()) as SignRequest;
  } catch {
    return json(400, { error: 'Body ist kein gültiges JSON.' });
  }

  const { key, contentType, size, checksum } = body;

  if (typeof key !== 'string' || !isValidAssetKey(key)) {
    return json(400, { error: 'Ungültiger Asset-Key.' });
  }
  if (typeof contentType !== 'string' || !ALLOWED_CONTENT_TYPES.has(contentType)) {
    return json(400, { error: `Content-Type ${String(contentType)} ist nicht zugelassen.` });
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    return json(400, { error: 'Größe fehlt oder ist ungültig.' });
  }
  if (typeof checksum !== 'string' || !checksumMatchesKey(key, checksum)) {
    return json(400, { error: 'Prüfsumme fehlt oder passt nicht zum Asset-Key.' });
  }
  if (size > MAX_UPLOAD_BYTES) {
    return json(413, {
      error: `Datei ist ${(size / 1024 / 1024).toFixed(1)} MB groß – erlaubt sind ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Optimiere das Modell zuerst.`,
    });
  }

  // The budget check. Deliberately the last gate before a signature is issued,
  // because a signature is the only thing standing between a browser and a
  // write into a metered bucket.
  //
  // The cached figure decides the common case for free. Only a request that
  // the cache says would not fit pays for a fresh measurement, which is what
  // keeps a stale count from refusing an upload that a cleanup has just made
  // room for.
  const limit = quotaBytes(env);
  let usage = await bucketUsage(env);
  if (usage.bytes + size > limit) {
    usage = await bucketUsage(env, { force: true });
    if (usage.bytes + size > limit) {
      return json(507, {
        error: `Der Team-Speicher ist voll: ${formatBytes(usage.bytes)} von ${formatBytes(limit)} belegt, diese Datei braucht ${formatBytes(size)}. Optimiere das Modell oder gib Speicher frei.`,
        usedBytes: usage.bytes,
        quotaBytes: limit,
      });
    }
  }

  const headers = {
    'content-type': contentType,
    'content-length': String(size),
    'cache-control': IMMUTABLE_CACHE_CONTROL,
    // R2 recomputes SHA-256 over the body and answers 400 on a mismatch. This
    // is what turns the content-addressed key from a convention into a
    // guarantee; validated against the key above, so both ends agree.
    'x-amz-checksum-sha256': checksum,
  };

  // Signed through AwsV4Signer rather than AwsClient.sign(new Request(...)):
  // Content-Length is a forbidden header on a Request, so routing through one
  // would drop it from the signature and quietly give up the size guarantee.
  // A standalone Headers object has no such guard.
  //
  // `allHeaders` is what pulls content-type and content-length into
  // X-Amz-SignedHeaders at all — aws4fetch treats both as unsignable by
  // default. The TTL has to travel as a query parameter; there is no option for
  // it, and without one aws4fetch would default to 24 hours.
  const signer = new AwsV4Signer({
    url: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}?X-Amz-Expires=${SIGNATURE_TTL_SECONDS}`,
    method: 'PUT',
    headers,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
    signQuery: true,
    allHeaders: true,
  });
  const signed = await signer.sign();

  // Booked against the budget now, not when the upload finishes: the PUT never
  // passes through this Worker, so this is the last moment we know about it.
  // The booking outlives exactly this signature, because that is how long the
  // bytes it authorises can still arrive.
  reserve(size, SIGNATURE_TTL_SECONDS * 1000);

  // The client must replay these headers verbatim — they are covered by the
  // signature, so any deviation makes R2 reject the PUT.
  return json(200, {
    uploadUrl: signed.url.toString(),
    headers,
    publicUrl: publicUrl(env, key),
    expiresIn: SIGNATURE_TTL_SECONDS,
  });
}
