import { API_BASE, isHostingConfigured } from './config';

/**
 * A failure the UI can explain. `kind` exists so callers can tell "log back in"
 * apart from "this file is too big" without matching on message strings.
 */
export class ApiError extends Error {
  constructor(
    readonly kind:
      | 'unauthenticated'
      | 'too-large'
      | 'conflict'
      | 'rejected'
      | 'network'
      | 'not-configured'
      /** The team storage budget is used up. Distinct from `too-large`:
       *  the file is fine, there is just no room for it. */
      | 'quota-exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Calls the studio Worker on the same origin, with the Cloudflare Access
 * cookie riding along.
 *
 * Access answers an expired session with a redirect to its own login page,
 * which fetch follows and hands back as an opaque HTML 200. Taking that for
 * success would surface as a JSON parse error halfway through an upload, so the
 * redirect is caught here and turned into a single honest failure mode.
 */
export async function callApi(path: string, init?: RequestInit): Promise<Response> {
  if (!isHostingConfigured()) {
    throw new ApiError('not-configured', 'Hosting ist in diesem Build deaktiviert.');
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...init });
  } catch (err) {
    throw new ApiError('network', `Hosting nicht erreichbar: ${(err as Error).message}`);
  }

  if (response.status === 401 || response.redirected) {
    throw new ApiError(
      'unauthenticated',
      'Sitzung abgelaufen. Seite neu laden, um dich erneut anzumelden.',
    );
  }
  return response;
}

export async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}
