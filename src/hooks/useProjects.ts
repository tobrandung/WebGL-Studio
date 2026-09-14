import { useCallback, useEffect, useState } from 'react';
import { getDB, generateId, type Project, type ProjectSettings, type CameraPath } from '@/lib/db';
import { isHostingConfigured } from '@/lib/storage/config';
import { deleteRemoteProject } from '@/lib/sync/projects';

const DEFAULT_SETTINGS: ProjectSettings = {
  // Kein reines Grau, und das ist Absicht: das Eigenschaften-Panel leitet die
  // aktive Hintergrund-Karte aus der Farbe ab (`isPureGray`), neue Projekte
  // starten damit auf „eigene Farbe" statt auf dem Graustufen-Regler.
  background: '#1b1818',
  transparent: false,
};

const DEFAULT_CAMERA_PATH: CameraPath = {
  keyframes: [],
  isLoop: true,
  speed: 1,
};

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const db = await getDB();
    const all = await db.getAllFromIndex('projects', 'by-updated');
    setProjects(all.reverse());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const createProject = useCallback(
    async (name: string): Promise<Project> => {
      const db = await getDB();
      const now = Date.now();
      const project: Project = {
        id: generateId(),
        name,
        thumbnail: '',
        settings: { ...DEFAULT_SETTINGS },
        cameraPath: { ...DEFAULT_CAMERA_PATH, keyframes: [] },
        createdAt: now,
        updatedAt: now,
      };
      await db.put('projects', project);
      await load();
      return project;
    },
    [load],
  );

  const updateProject = useCallback(
    async (id: string, updates: Partial<Omit<Project, 'id' | 'createdAt'>>) => {
      const db = await getDB();
      const existing = await db.get('projects', id);
      if (!existing) return;
      const updated = { ...existing, ...updates, updatedAt: Date.now() };
      await db.put('projects', updated);
      await load();
    },
    [load],
  );

  /**
   * Deletes the project locally and in R2.
   *
   * Both, because a local-only delete would leave the project showing up again
   * under "Im Team-Speicher" — and because the remote copy is the shared one,
   * this is destructive for colleagues too. The dashboard therefore asks first.
   *
   * Published assets are deliberately left in R2: they are content-addressed,
   * may be shared with another project, and may still be serving an embed on a
   * live customer site.
   */
  const deleteProject = useCallback(
    async (id: string) => {
      const db = await getDB();
      const models = await db.getAllFromIndex('models', 'by-project', id);
      const tx = db.transaction(['projects', 'models', 'blobs'], 'readwrite');
      await tx.objectStore('projects').delete(id);
      for (const model of models) {
        await tx.objectStore('models').delete(model.id);
        await tx.objectStore('blobs').delete(model.id);
      }
      await tx.done;

      if (isHostingConfigured()) {
        // A failed remote delete is not worth failing the local one over; the
        // project simply reappears as a team entry until the next attempt.
        await deleteRemoteProject(id).catch(() => {});
      }
      await load();
    },
    [load],
  );

  const duplicateProject = useCallback(
    async (id: string): Promise<Project | null> => {
      const db = await getDB();
      const existing = await db.get('projects', id);
      if (!existing) return null;

      const now = Date.now();
      const newId = generateId();
      const duplicate: Project = {
        ...existing,
        id: newId,
        name: `${existing.name} (Kopie)`,
        createdAt: now,
        updatedAt: now,
      };
      await db.put('projects', duplicate);

      const models = await db.getAllFromIndex('models', 'by-project', id);
      for (const model of models) {
        const newModelId = generateId();
        await db.put('models', { ...model, id: newModelId, projectId: newId });
        const blob = await db.get('blobs', model.id);
        if (blob) {
          await db.put('blobs', { id: newModelId, data: blob.data });
        }
      }

      await load();
      return duplicate;
    },
    [load],
  );

  return { projects, loading, createProject, updateProject, deleteProject, duplicateProject };
}
