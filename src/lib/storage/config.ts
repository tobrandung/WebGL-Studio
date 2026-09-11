/**
 * The API lives on the same origin as the SPA because both are served by the
 * studio Worker — which is what lets the Cloudflare Access cookie ride along on
 * a plain same-origin request. In `vite dev` the Vite proxy forwards /api to a
 * local `wrangler dev`.
 *
 * The public CDN base is deliberately *not* configured here: /api/sign returns
 * the finished public URL, so the browser never has to know where delivery
 * happens and the two can be moved apart (Worker today, R2 custom domain later)
 * without touching the client.
 */
export const API_BASE = '/api';

/**
 * Whether hosting is reachable at all. Set VITE_ASSET_HOSTING=off to work
 * offline against download/folder export only — useful when the Worker is not
 * running and the export dialog would otherwise just fail.
 */
export function isHostingConfigured(): boolean {
  return import.meta.env.VITE_ASSET_HOSTING !== 'off';
}
