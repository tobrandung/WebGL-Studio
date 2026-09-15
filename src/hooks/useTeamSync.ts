import { useCallback, useEffect, useRef, useState } from 'react';
import { getDB, type Project } from '@/lib/db';
import { isHostingConfigured } from '@/lib/storage/config';
import { listRemoteProjects, fetchRemoteProject } from '@/lib/sync/projects';

/**
 * Mirrors the team's projects into this browser, without asking.
 *
 * This used to be a second list on the dashboard with a download button per
 * project, and the result was that a colleague's work looked like a stub: no
 * thumbnail, no preview, no export, and an import click before any of it. So
 * the list is gone and the sync happens on load. Everyone sees the same
 * dashboard.
 *
 * Only records travel, never blobs. A project's models stay in R2 until
 * something actually renders them, which `loadBlob` handles per asset, so
 * mirroring twenty projects costs kilobytes rather than gigabytes.
 *
 * Documents are fetched only when their ETag differs from the copy we hold, so
 * the steady-state cost of opening the dashboard is one list request.
 */
export type TeamSyncState = {
  /** True while the first pass of a session is running. */
  syncing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

/**
 * Whose version wins when both sides moved.
 *
 * `updatedAt` on the local record is the last local edit; on the summary it is
 * the last push by anyone. A local record newer than the remote one therefore
 * holds edits that have not been pushed yet, usually because the editor was
 * offline, and pulling would throw them away. Everything else means someone
 * else saved after we last did, and their version is the current one.
 */
function shouldPull(local: Project | undefined, remote: { etag: string; updatedAt: number }): boolean {
  if (!local) return true;
  if (local.remote?.etag === remote.etag) return false;
  return local.updatedAt <= remote.updatedAt;
}

export function useTeamSync(localLoading: boolean, onChanged: () => void): TeamSyncState {
  const [syncing, setSyncing] = useState(isHostingConfigured());
  const [error, setError] = useState<string | null>(null);
  const onChangedRef = useRef(onChanged);

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const refresh = useCallback(async () => {
    if (!isHostingConfigured()) {
      setSyncing(false);
      return;
    }
    setSyncing(true);
    try {
      const remote = await listRemoteProjects();
      const db = await getDB();
      let changed = false;

      for (const summary of remote) {
        const local = await db.get('projects', summary.id);
        if (!shouldPull(local, summary)) continue;

        const { document, etag } = await fetchRemoteProject(summary.id);
        const existingModels = local
          ? await db.getAllFromIndex('models', 'by-project', summary.id)
          : [];
        const incoming = new Set(document.models.map((m) => m.id));

        const tx = db.transaction(['projects', 'models'], 'readwrite');
        await tx.objectStore('projects').put({
          ...document.project,
          remote: { etag, syncedAt: Date.now(), author: summary.author },
        });
        for (const model of document.models) {
          await tx.objectStore('models').put(model);
        }
        // A model the incoming version no longer has was deleted by whoever
        // saved it. Keeping ours would show a scene that is neither version.
        for (const model of existingModels) {
          if (!incoming.has(model.id)) await tx.objectStore('models').delete(model.id);
        }
        await tx.done;
        changed = true;
      }

      setError(null);
      if (changed) onChangedRef.current();
    } catch (err) {
      // The local projects are all still there and usable, so this is a note on
      // the dashboard rather than a failure of it.
      setError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    if (localLoading) return;
    void refresh();
  }, [refresh, localLoading]);

  return { syncing, error, refresh };
}
