import { authenticate, type AuthEnv } from './auth.ts';
import { handleSign, handleExists, handleUsage, type SignEnv } from './sign.ts';
import { handleProjects, type ProjectsEnv } from './projects.ts';

type Env = AuthEnv &
  SignEnv &
  ProjectsEnv & {
    /** Static asset binding holding the built SPA (dist/). */
    STATIC: Fetcher;
  };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * The studio Worker serves the SPA and its API from one origin.
 *
 * That is the point, not a convenience: Cloudflare Access authenticates with a
 * cookie, and a cross-site XHR from a separately hosted SPA would have it
 * stripped by Safari's tracking prevention. Same-origin also means no CORS
 * layer to get wrong on a write endpoint.
 *
 * Uploads still bypass this Worker — /api/sign hands the browser a presigned
 * URL straight to R2.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.STATIC.fetch(request);
    }

    const identity = await authenticate(request, env);
    if (!identity) {
      return json(401, { error: 'Nicht angemeldet. Seite neu laden, um dich anzumelden.' });
    }

    if (url.pathname === '/api/sign') {
      if (request.method === 'GET') return handleExists(request, env);
      if (request.method === 'POST') return handleSign(request, env);
      return json(405, { error: 'Method not allowed' });
    }

    if (url.pathname === '/api/usage') {
      if (request.method !== 'GET') return json(405, { error: 'Method not allowed' });
      return handleUsage(env);
    }

    if (url.pathname === '/api/me') {
      return json(200, { name: identity.name, service: identity.service });
    }

    if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')) {
      const id = url.pathname.slice('/api/projects'.length).replace(/^\//, '') || null;
      return handleProjects(request, env, identity, id);
    }

    return json(404, { error: 'Unbekannter Endpunkt.' });
  },
};
