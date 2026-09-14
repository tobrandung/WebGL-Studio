import { useCallback, useEffect, useState } from 'react';
import { getDB, generateId, type ModelEntry } from '@/lib/db';
import { loadBlob } from '@/lib/storage/blob-cache';

export function useModels(projectId: string) {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const db = await getDB();
    const all = await db.getAllFromIndex('models', 'by-project', projectId);
    all.sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
    setModels(all);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const addModel = useCallback(
    async (
      file: File,
      name?: string,
      /**
       * Initial transform. Written into the record rather than applied to the
       * viewport group afterwards, because models are loaded asynchronously, so
       * the group does not exist yet when the caller returns.
       */
      transform?: Pick<ModelEntry, 'position' | 'rotation' | 'scale'>,
    ): Promise<ModelEntry> => {
      const db = await getDB();
      const id = generateId();
      const buffer = await file.arrayBuffer();

      const now = Date.now();
      const entry: ModelEntry = {
        id,
        projectId,
        name: name ?? file.name.replace(/\.[^.]+$/, ''),
        fileName: file.name,
        fileSize: file.size,
        position: transform?.position ?? [0, 0, 0],
        rotation: transform?.rotation ?? [0, 0, 0],
        scale: transform?.scale ?? [1, 1, 1],
        createdAt: now,
        order: now,
        groupId: null,
      };

      const tx = db.transaction(['models', 'blobs'], 'readwrite');
      await tx.objectStore('models').put(entry);
      await tx.objectStore('blobs').put({ id, data: buffer });
      await tx.done;

      await load();
      return entry;
    },
    [projectId, load],
  );

  const updateModel = useCallback(
    async (id: string, updates: Partial<Omit<ModelEntry, 'id' | 'projectId' | 'createdAt'>>) => {
      const db = await getDB();
      const existing = await db.get('models', id);
      if (!existing) return;
      await db.put('models', { ...existing, ...updates });
      await load();
    },
    [load],
  );

  /**
   * Removes the model record but deliberately keeps its blob, so an undo can
   * restore the model without having to hold the (potentially huge) buffer in
   * the history stack. Unreferenced blobs are collected by `sweepOrphanBlobs`.
   */
  const deleteModel = useCallback(
    async (id: string) => {
      const db = await getDB();
      await db.delete('models', id);
      await load();
    },
    [load],
  );

  /** Writes a previously captured entry back under its original id (undo). */
  const restoreModel = useCallback(
    async (entry: ModelEntry) => {
      const db = await getDB();
      await db.put('models', entry);
      await load();
    },
    [load],
  );

  /** The model's bytes, from IndexedDB or, for a synced project, the CDN. */
  const getModelBlob = useCallback(async (id: string): Promise<ArrayBuffer | null> => {
    const db = await getDB();
    const record = await db.get('models', id);
    return loadBlob(id, record?.assetKey);
  }, []);

  /**
   * Persists a new ordering and (optional) group assignment for the given models
   * in a single transaction, then reloads once. `updates` maps a model id to its
   * new order index and target group.
   */
  const reorderModels = useCallback(
    async (updates: { id: string; order: number; groupId: string | null }[]) => {
      const db = await getDB();
      const tx = db.transaction('models', 'readwrite');
      const store = tx.objectStore('models');
      for (const { id, order, groupId } of updates) {
        const existing = await store.get(id);
        if (existing) await store.put({ ...existing, order, groupId });
      }
      await tx.done;
      await load();
    },
    [load],
  );

  return { models, loading, addModel, updateModel, deleteModel, restoreModel, getModelBlob, reorderModels };
}
