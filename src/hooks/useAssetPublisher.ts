import { useEffect, useMemo, useRef, useState } from 'react';
import type { EnvironmentConfig, ModelEntry } from '@/lib/db';
import { isHostingConfigured } from '@/lib/storage/config';
import {
  pendingAssetKey,
  publishPendingAssets,
  type PublishFailure,
  type PublishResult,
} from '@/lib/sync/assets';

/**
 * Keeps the project's assets published, so the scene a colleague opens is the
 * scene you see.
 *
 * Runs on its own rather than on save: the upload of a 40 MB model takes long
 * enough that blocking the autosave on it would make the editor feel stuck, and
 * the local write has already happened by then anyway. When it finishes,
 * `onPublished` lets the editor fold the new keys into its state and schedule
 * the save that carries them into the project document.
 */
export function useAssetPublisher(
  projectId: string,
  models: ModelEntry[],
  environment: EnvironmentConfig | null,
  onPublished: (result: PublishResult) => void,
) {
  const [publishing, setPublishing] = useState(false);
  const [failures, setFailures] = useState<PublishFailure[]>([]);
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const onPublishedRef = useRef(onPublished);
  /**
   * The pending set we last attempted. Without it a permanent failure (a model
   * too large to publish) would re-enter this effect on every render and retry
   * the upload forever.
   */
  const attemptedRef = useRef<string | null>(null);

  useEffect(() => {
    onPublishedRef.current = onPublished;
  }, [onPublished]);

  const pending = useMemo(() => pendingAssetKey(models, environment), [models, environment]);

  useEffect(() => {
    if (!projectId || !pending || !isHostingConfigured()) return;
    if (attemptedRef.current === pending) return;
    attemptedRef.current = pending;

    let cancelled = false;
    setPublishing(true);
    (async () => {
      try {
        const result = await publishPendingAssets(projectId);
        if (cancelled) return;
        setFailures(result.failures);
        setQuotaExceeded(result.quotaExceeded);
        onPublishedRef.current(result);
      } finally {
        if (!cancelled) setPublishing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, pending]);

  return { publishing, failures, quotaExceeded };
}
