import { getDB } from '../db';
import { lookupAsset } from './client';

/**
 * The bytes behind a stored asset, falling back to the CDN when this browser
 * has never held them.
 *
 * That fallback is what makes a synced project usable at all: the records come
 * down from R2 but the blobs do not, so the viewport loader, the optimizer, the
 * export dialog and the preview page would each otherwise see an empty scene.
 * The download is cached under the same blob id, so it costs one fetch per
 * asset per browser and every consumer keeps working against IndexedDB.
 *
 * Resolving the public URL through the API rather than composing it here keeps
 * the delivery origin out of the client — moving from the CDN Worker to an R2
 * custom domain later changes nothing in the app.
 */
export async function loadBlob(id: string, assetKey?: string): Promise<ArrayBuffer | null> {
  const db = await getDB();
  const stored = await db.get('blobs', id);
  if (stored) return stored.data;
  if (!assetKey) return null;

  try {
    const { exists, publicUrl } = await lookupAsset(assetKey);
    if (!exists) return null;
    const response = await fetch(publicUrl);
    if (!response.ok) return null;
    const data = await response.arrayBuffer();
    await db.put('blobs', { id, data });
    return data;
  } catch {
    // Hosting unreachable or session expired. Callers treat a null as "not
    // available yet" and render without it rather than failing the whole load.
    return null;
  }
}
