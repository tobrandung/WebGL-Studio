/**
 * Verifies the Cloudflare Access JWT that the edge puts on every request to
 * this Worker.
 *
 * Access already blocks unauthenticated traffic before our code runs, so this
 * is a second lock on the same door — worth having because the first one is a
 * dashboard setting. If someone removes the policy, or binds the Worker to a
 * route that bypasses it, these handlers still refuse rather than quietly
 * turning into an open write endpoint.
 */

export type Identity = {
  /** Human identity for a browser session, or the service token's name. */
  name: string;
  /** True for Access service tokens (the widget publish script). */
  service: boolean;
};

type JsonWebKey = { kid: string; kty: string; alg: string; n: string; e: string; use?: string };

/** Isolates are reused, so a short in-memory cache spares most JWKS fetches. */
let jwksCache: { keys: Map<string, CryptoKey>; expiresAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

async function loadKeys(teamDomain: string): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (jwksCache && jwksCache.expiresAt > now) return jwksCache.keys;

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: JsonWebKey[] };

  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (jwk.kty !== 'RSA') continue;
    imported.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    );
  }
  jwksCache = { keys: imported, expiresAt: now + JWKS_TTL_MS };
  return imported;
}

export type AuthEnv = {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /**
   * Local-development identity. Only honoured while ACCESS_AUD is unset, which
   * is never the case in a deployed Worker — so this cannot be turned on in
   * production by setting one variable.
   */
  DEV_IDENTITY?: string;
};

/**
 * Resolves the caller, or null when the request carries no valid Access token.
 * Callers translate null into 401 — never into "anonymous".
 */
export async function authenticate(request: Request, env: AuthEnv): Promise<Identity | null> {
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) {
    return env.DEV_IDENTITY ? { name: env.DEV_IDENTITY, service: false } : null;
  }

  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ??
    // Service tokens (wrangler/CI) reach us as a cookie rather than a header.
    /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('Cookie') ?? '')?.[1];
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeSegment(parts[0]);
    payload = decodeSegment(parts[1]);
  } catch {
    return null;
  }

  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

  const keys = await loadKeys(env.ACCESS_TEAM_DOMAIN);
  const key = keys.get(header.kid);
  if (!key) return null;

  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds + 60) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;

  // A user token carries `email`; a service token carries `common_name`.
  if (typeof payload.email === 'string') return { name: payload.email, service: false };
  if (typeof payload.common_name === 'string') return { name: payload.common_name, service: true };
  return null;
}
