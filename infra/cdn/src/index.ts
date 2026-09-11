import { isValidAssetKey, IMMUTABLE_CACHE_CONTROL } from '../../shared/asset-key.ts';

type Env = { ASSETS: R2Bucket };

/**
 * three.js fetches models cross-origin from whatever page embeds the widget, so
 * the delivery origin has to be open. That is safe here because this Worker is
 * read-only and the keys are content hashes: knowing a URL reveals nothing but
 * the file it already names.
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-None-Match',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag',
  'Access-Control-Max-Age': '86400',
};

function plain(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS },
  });
}

function isR2ObjectBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
  return 'body' in object;
}

/**
 * R2 reports the served range in one of three shapes — offset+length, offset
 * only (open-ended), or a suffix count ("last N bytes") — and Content-Range
 * needs absolute numbers for all of them.
 *
 * Discriminating on the *values* rather than with `'suffix' in range`, because
 * the runtime hands back an object that carries all three keys with `undefined`
 * for the ones that do not apply. The `in` check therefore always picks the
 * suffix branch, and `size - undefined` had this serving
 * `Content-Range: bytes NaN-NaN/20480` for every ranged request.
 */
function resolveRange(range: R2Range, size: number): { offset: number; length: number } {
  const suffix = (range as { suffix?: number }).suffix;
  if (typeof suffix === 'number') {
    return { offset: size - suffix, length: suffix };
  }
  const { offset, length } = range as { offset?: number; length?: number };
  const start = typeof offset === 'number' ? offset : 0;
  return { offset: start, length: typeof length === 'number' ? length : size - start };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plain(405, 'Method not allowed');
    }

    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1));
    if (!isValidAssetKey(key)) return plain(404, 'Not found');

    const isRange = request.headers.has('range');

    // Only full-body GETs go through the cache. A ranged response is a partial
    // body and caching it under the plain request URL would later be served as
    // if it were the whole file.
    const cache = caches.default;
    if (request.method === 'GET' && !isRange) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }

    /**
     * Carries the Content-Type and Cache-Control that were signed into the
     * upload, so the delivery contract is decided once, at write time.
     */
    const metadataHeaders = (object: R2Object): Headers => {
      const headers = new Headers(CORS);
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('cache-control', IMMUTABLE_CACHE_CONTROL);
      headers.set('accept-ranges', 'bytes');
      return headers;
    };

    if (request.method === 'HEAD') {
      const object = await env.ASSETS.head(key);
      if (object === null) return plain(404, 'Not found');
      const headers = metadataHeaders(object);
      headers.set('content-length', String(object.size));
      return new Response(null, { status: 200, headers });
    }

    const object = await env.ASSETS.get(key, {
      range: request.headers,
      onlyIf: request.headers,
    });
    if (object === null) return plain(404, 'Not found');

    const headers = metadataHeaders(object);

    // A conditional request that matched: R2 returns metadata without a body.
    if (!isR2ObjectBody(object)) {
      return new Response(null, { status: 304, headers });
    }

    if (isRange && object.range) {
      const { offset, length } = resolveRange(object.range, object.size);
      headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set('content-length', String(length));
      return new Response(object.body, { status: 206, headers });
    }

    headers.set('content-length', String(object.size));
    const response = new Response(object.body, { status: 200, headers });
    // Tee into the colo cache without making the client wait for it.
    ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  },
};
