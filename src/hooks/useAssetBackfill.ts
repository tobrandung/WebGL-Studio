import { useEffect, useRef, useState } from 'react';
import { getDB, type Project } from '@/lib/db';
import { isHostingConfigured } from '@/lib/storage/config';
import { pendingAssetKey, publishPendingAssets } from '@/lib/sync/assets';
import { pushProject, toDocument } from '@/lib/sync/projects';

/**
 * Publishes the assets of projects made before publishing was automatic.
 *
 * Every project that predates this carries models that only ever existed in
 * their author's IndexedDB, so a colleague opening one got an empty scene. The
 * editor now publishes on its own, but only for a project somebody opens, and
 * nobody is going to open twenty projects to fix twenty projects. So the
 * dashboard does one pass.
 *
 * Deliberately sequential and once per session: this can move hundreds of
 * megabytes on the first run, and saturating the uplink with parallel uploads
 * would make the editor feel broken for as long as it lasts. Projects whose
 * bytes this browser does not hold cost a lookup and are skipped; for those,
 * the machine that made them is the one that has to run this.
 */
export type BackfillProgress = { name: string; index: number; total: number };

export function useAssetBackfill(projects: Project[], ready: boolean, onChanged: () => void) {
  const [progress, setProgress] = useState<BackfillProgress | null>(null);
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const startedRef = useRef(false);
  const projectsRef = useRef(projects);
  const onChangedRef = useRef(onChanged);

  useEffect(() => {
    projectsRef.current = projects;
    onChangedRef.current = onChanged;
  }, [projects, onChanged]);

  useEffect(() => {
    if (!ready || startedRef.current || !isHostingConfigured()) return;
    startedRef.current = true;

    let cancelled = false;
    (async () => {
      const db = await getDB();
      const candidates: Project[] = [];
      for (const project of projectsRef.current) {
        const models = await db.getAllFromIndex('models', 'by-project', project.id);
        if (pendingAssetKey(models, project.environment)) candidates.push(project);
      }
      if (!candidates.length || cancelled) return;

      let changed = false;
      for (const [index, project] of candidates.entries()) {
        if (cancelled) return;
        setProgress({ name: project.name, index: index + 1, total: candidates.length });

        const result = await publishPendingAssets(project.id);
        // Nothing else will fit either, so stop rather than walking the rest of
        // the list to collect the same refusal once per project.
        if (result.quotaExceeded) {
          setQuotaExceeded(true);
          break;
        }
        if (!Object.keys(result.modelKeys).length && !result.environmentKey) continue;

        // The keys are on the records now; the team only benefits once the
        // document that references them is pushed.
        const current = await db.get('projects', project.id);
        if (!current) continue;
        const models = await db.getAllFromIndex('models', 'by-project', project.id);
        try {
          const pushed = await pushProject(toDocument(current, models), current.remote?.etag);
          await db.put('projects', {
            ...current,
            remote: { etag: pushed.etag, syncedAt: pushed.updatedAt, author: pushed.author },
          });
          changed = true;
        } catch {
          // A conflict or a dead connection here means the keys are stored and
          // the bytes are in R2; the next save from the editor carries them.
        }
      }

      if (cancelled) return;
      setProgress(null);
      if (changed) onChangedRef.current();

    })();

    return () => {
      cancelled = true;
    };
  }, [ready]);

  return { progress, quotaExceeded };
}
