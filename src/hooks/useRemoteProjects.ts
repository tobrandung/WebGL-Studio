import { useCallback, useEffect, useState } from 'react';
import { getDB, type Project } from '@/lib/db';
import { isHostingConfigured } from '@/lib/storage/config';
import { listRemoteProjects, fetchRemoteProject, type RemoteProjectSummary } from '@/lib/sync/projects';

/**
 * Projects that exist in R2 but not in this browser.
 *
 * The point of the list is hand-off: a colleague's project, or your own from
 * another machine, is otherwise invisible. Importing writes the records only —
 * no blobs — because `loadBlob` pulls each asset from the CDN on first use, so
 * opening a 200 MB project costs nothing until you actually look at it.
 */
export function useRemoteProjects(localProjects: Project[], localLoading: boolean) {
  const [remoteOnly, setRemoteOnly] = useState<RemoteProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isHostingConfigured()) return;
    try {
      const remote = await listRemoteProjects();
      const localIds = new Set(localProjects.map((p) => p.id));
      setRemoteOnly(remote.filter((r) => !localIds.has(r.id)));
      setError(null);
    } catch (err) {
      // A missing team list is not worth an error banner over the dashboard;
      // the local projects are all still there and usable.
      setRemoteOnly([]);
      setError((err as Error).message);
    }
  }, [localProjects]);

  useEffect(() => {
    if (localLoading) return;
    refresh();
  }, [refresh, localLoading]);

  /** Copies a remote project into IndexedDB. Returns its id on success. */
  const importProject = useCallback(async (id: string): Promise<string | null> => {
    setImporting(id);
    try {
      const { document, etag } = await fetchRemoteProject(id);
      const db = await getDB();
      const tx = db.transaction(['projects', 'models'], 'readwrite');
      await tx.objectStore('projects').put({
        ...document.project,
        remote: { etag, syncedAt: Date.now(), author: '' },
      });
      for (const model of document.models) {
        await tx.objectStore('models').put(model);
      }
      await tx.done;
      setRemoteOnly((prev) => prev.filter((r) => r.id !== id));
      return id;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setImporting(null);
    }
  }, []);

  return { remoteOnly, error, importing, importProject, refresh };
}
