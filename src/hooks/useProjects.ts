import { useCallback, useEffect, useState } from 'react';
import { getDB, generateId, type Project, type ProjectSettings, type CameraPath } from '@/lib/db';
import { isHostingConfigured } from '@/lib/storage/config';
import { deleteRemoteProject, type DeleteResult } from '@/lib/sync/projects';

const DEFAULT_SETTINGS: ProjectSettings = {
  // Kein reines Grau, und das ist Absicht: das Eigenschaften-Panel leitet die
  // aktive Hintergrund-Karte aus der Farbe ab (`isPureGray`), neue Projekte
  // starten damit auf „eigene Farbe" statt auf dem Graustufen-Regler.
  background: '#313030',
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
   * Deletes the project everywhere: locally, in the team storage, and with it
   * every published model and HDRI that no other project uses.
   *
   * Everywhere, because half a deletion is not one. A local-only delete leaves
   * the project to come back with the next team sync, and leaving its assets in
   * R2 means the bucket only ever grows, which under a storage ceiling ends
   * with nobody able to upload anything and no way to make room. It is also
   * destructive past this studio, an embed on a customer site loads exactly
   * these keys, which is why the dashboard makes you type the word first.
   *
   * Returns what the server removed, or null when there was no remote copy.
   */
  const deleteProject = useCallback(
    async (id: string): Promise<DeleteResult | null> => {
      const db = await getDB();
      const models = await db.getAllFromIndex('models', 'by-project', id);
      const tx = db.transaction(['projects', 'models', 'blobs'], 'readwrite');
      await tx.objectStore('projects').delete(id);
      for (const model of models) {
        await tx.objectStore('models').delete(model.id);
        await tx.objectStore('blobs').delete(model.id);
      }
      await tx.done;

      let result: DeleteResult | null = null;
      if (isHostingConfigured()) {
        // A failed remote delete is not worth failing the local one over; the
        // project simply reappears as a team entry until the next attempt.
        result = await deleteRemoteProject(id).catch(() => null);
      }
      await load();
      return result;
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

  return {
    projects,
    loading,
    reload: load,
    createProject,
    updateProject,
    deleteProject,
    duplicateProject,
  };
}
