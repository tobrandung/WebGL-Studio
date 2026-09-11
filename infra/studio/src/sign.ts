import { AwsV4Signer } from 'aws4fetch';
import {
  isValidAssetKey,
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  IMMUTABLE_CACHE_CONTROL,
} from '../../shared/asset-key.ts';

export type SignEnv = {
  ASSETS: R2Bucket;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** Public base URL of the delivery Worker, e.g. https://web3d-cdn.x.workers.dev */
  CDN_BASE: string;
};

const SIGNATURE_TTL_SECONDS = 300;

type SignRequest = { key?: unknown; contentType?: unknown; size?: unknown };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
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
 * Content-Type, Cache-Control and Content-Length are part of the signature, so
 * the client cannot store a file that is bigger, differently typed, or less
 * cacheable than what was approved here.
 */
export async function handleSign(request: Request, env: SignEnv): Promise<Response> {
  let body: SignRequest;
  try {
    body = (await request.json()) as SignRequest;
  } catch {
    return json(400, { error: 'Body ist kein gültiges JSON.' });
  }

  const { key, contentType, size } = body;

  if (typeof key !== 'string' || !isValidAssetKey(key)) {
    return json(400, { error: 'Ungültiger Asset-Key.' });
  }
  if (typeof contentType !== 'string' || !ALLOWED_CONTENT_TYPES.has(contentType)) {
    return json(400, { error: `Content-Type ${String(contentType)} ist nicht zugelassen.` });
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    return json(400, { error: 'Größe fehlt oder ist ungültig.' });
  }
  if (size > MAX_UPLOAD_BYTES) {
    return json(413, {
      error: `Datei ist ${(size / 1024 / 1024).toFixed(1)} MB groß – erlaubt sind ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Optimiere das Modell zuerst.`,
    });
  }

  const headers = {
    'content-type': contentType,
    'content-length': String(size),
    'cache-control': IMMUTABLE_CACHE_CONTROL,
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

  // The client must replay these headers verbatim — they are covered by the
  // signature, so any deviation makes R2 reject the PUT.
  return json(200, {
    uploadUrl: signed.url.toString(),
    headers,
    publicUrl: publicUrl(env, key),
    expiresIn: SIGNATURE_TTL_SECONDS,
  });
}
