import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { formatFromFileName } from './hdri/format';
import type { EnvironmentFormat } from './hdri/types';

export type Vec3 = [number, number, number];

export type ProjectSettings = {
  background: string;
  transparent: boolean;
};

export type LightType = 'ambient' | 'directional' | 'point' | 'spot';

export type LightEntry = {
  id: string;
  name: string;
  type: LightType;
  /** Hex color string, e.g. "#ffffff". */
  color: string;
  intensity: number;
  /** World position. Ignored for ambient lights. */
  position: Vec3;
  /** Aim point for directional/spot lights. */
  target?: Vec3;
  /** Range for point/spot lights (0 = infinite). */
  distance?: number;
  /** Physical falloff for point/spot lights. */
  decay?: number;
  /** Cone angle in radians for spot lights. */
  angle?: number;
  /** Soft cone edge (0-1) for spot lights. */
  penumbra?: number;
  /** Renders a shadow map. Absent on older lights, which cast no shadow. */
  castShadow?: boolean;
  visible?: boolean;
  order?: number;
};

/** A flat ground surface that catches shadows. */
export type PlaneEntry = {
  id: string;
  name: string;
  position: Vec3;
  /** Euler angles in radians. Zero lies flat on the XZ floor. */
  rotation: Vec3;
  /** X and Z are the plane's width and depth; Y has no visible effect. */
  scale: Vec3;
  /** Hex color string, e.g. "#808080". Unused while `shadowOnly`. */
  color: string;
  /** Hides the surface itself and draws only the shadows falling on it. */
  shadowOnly: boolean;
  /** Shadow darkness (0-1) while `shadowOnly`. */
  shadowOpacity: number;
  visible?: boolean;
  order?: number;
};

export type EnvironmentConfig = {
  /** Key into the `blobs` store holding the equirectangular image. */
  blobId: string;
  fileName: string;
  /** Render the image as the visible scene background (dome). */
  showBackground: boolean;
  /** Use the image as IBL reflection source (scene.environment). */
  useForReflection: boolean;
  /** Global environment/background intensity. */
  intensity: number;
  /** Optional background blur (0-1) when shown as background. */
  blurriness?: number;
  /**
   * Which decoder the blob needs. Absent on records written before the
   * converter existed. Derive it from `fileName` via `formatFromFileName`.
   */
  format?: EnvironmentFormat;
  /** Byte length of the stored blob. Absent on older records. */
  fileSize?: number;
  /** Pixel dimensions of the stored image. Absent on older records. */
  width?: number;
  height?: number;
  /** Name of the file the user picked, before conversion renamed it. */
  sourceFileName?: string;
  /** Id of the bundled HDRI this came from, if any. */
  presetId?: string;
  /**
   * Content-addressed key this blob was published under, e.g.
   * `a/1a2b3c4d5e6f7a8b.webp`. Present once the project has been exported.
   * Lets the export dialog recognise an already-published asset without
   * re-hashing the blob, and lets a project opened on another machine load the
   * environment from the CDN when the local blob is absent.
   */
  assetKey?: string;
};

/**
 * Which decoder a stored environment needs. Records written before the HDRI
 * converter existed carry no `format`; their extensions are unambiguous
 * (`.hdr`/`.exr`/`.png`/`.webp`. Ultra HDR did not exist yet), so deriving it
 * from the file name is correct for them and no migration is needed.
 */
export function environmentFormat(env: EnvironmentConfig): EnvironmentFormat {
  return env.format ?? formatFromFileName(env.fileName);
}

export type ModelEntry = {
  id: string;
  projectId: string;
  name: string;
  fileName: string;
  fileSize: number;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  createdAt: number;
  /** Display order in the scene outliner (ascending). Older records may lack it. */
  order?: number;
  /** Id of the containing outliner group, or null/undefined when ungrouped. */
  groupId?: string | null;
  /**
   * Content-addressed key this model was published under, e.g.
   * `a/1a2b3c4d5e6f7a8b.glb`. Absent until the project is exported. Doubles as
   * the CDN fallback when the local blob is gone. Which is the case for every
   * model in a project that was synced from another machine.
   */
  assetKey?: string;
};

export type SceneGroup = {
  id: string;
  name: string;
  collapsed: boolean;
  order: number;
};

export type KeyframeData = {
  /** Stable id. Absent in projects saved before keyframes became editable. */
  id?: string;
  position: [number, number, number];
  lookAt: [number, number, number];
};

/**
 * Wie die Kamerafahrt abgespielt wird. Im Export-Widget wie in der Vorschau.
 * Im Export-Dialog gewählt und dort sofort gespeichert, damit die Vorschau
 * dieselbe Fahrt zeigt wie das eingebettete Widget.
 */
export type PlaybackMode = 'scroll' | 'autoplay' | 'loop';

export type CameraPath = {
  keyframes: KeyframeData[];
  isLoop: boolean;
  speed: number;
  /** Fehlt bei Projekten aus der Zeit vor dieser Einstellung. Dann 'scroll'. */
  playbackMode?: PlaybackMode;
};

export type Project = {
  id: string;
  name: string;
  thumbnail: string;
  settings: ProjectSettings;
  cameraPath: CameraPath;
  createdAt: number;
  updatedAt: number;
  /** Scene outliner groups (flat, single level). Older projects may lack it. */
  groups?: SceneGroup[];
  /** Placed light sources. Older projects lack it and get seeded defaults. */
  lights?: LightEntry[];
  /** Shadow-catching ground planes. Older projects lack it. */
  planes?: PlaneEntry[];
  /** Optional single equirectangular environment for reflections/background. */
  environment?: EnvironmentConfig | null;
  /**
   * Bookkeeping for the R2 copy of this project. Absent while a project has
   * never been synced, which is how the dashboard tells "local only" apart from
   * "synchronised".
   */
  remote?: {
    /** ETag of the version this editor last read; sent as If-Match on save. */
    etag: string;
    /** Server-side save time, not the local `updatedAt`. */
    syncedAt: number;
    /** Access identity that wrote that version. */
    author: string;
  };
};

interface Web3DStudioDB extends DBSchema {
  projects: {
    key: string;
    value: Project;
    indexes: { 'by-updated': number };
  };
  models: {
    key: string;
    value: ModelEntry;
    indexes: { 'by-project': string };
  };
  blobs: {
    key: string;
    value: { id: string; data: ArrayBuffer };
  };
}

let dbInstance: IDBPDatabase<Web3DStudioDB> | null = null;

export async function getDB(): Promise<IDBPDatabase<Web3DStudioDB>> {
  if (dbInstance) return dbInstance;

  // Still version 1: every field added since (environment formats, outliner
  // groups, lights, asset keys, remote sync state) is optional on the record
  // itself, and IndexedDB does not validate record shape. A version bump would
  // buy an upgrade transaction that has nothing to do.
  dbInstance = await openDB<Web3DStudioDB>('web3d-studio', 1, {
    upgrade(db) {
      const projectStore = db.createObjectStore('projects', { keyPath: 'id' });
      projectStore.createIndex('by-updated', 'updatedAt');

      const modelStore = db.createObjectStore('models', { keyPath: 'id' });
      modelStore.createIndex('by-project', 'projectId');

      db.createObjectStore('blobs', { keyPath: 'id' });
    },
  });

  return dbInstance;
}

export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Deletes blobs no longer referenced by any model record or project
 * environment. Model and environment deletions intentionally leave their blob
 * behind so an undo can restore them; this sweep is the deferred cleanup and
 * runs on project load, which also heals orphans left by older versions.
 */
export async function sweepOrphanBlobs(): Promise<number> {
  const db = await getDB();
  const referenced = new Set<string>();

  for (const model of await db.getAll('models')) referenced.add(model.id);
  for (const project of await db.getAll('projects')) {
    if (project.environment?.blobId) referenced.add(project.environment.blobId);
  }

  const orphans = (await db.getAllKeys('blobs')).filter((key) => !referenced.has(key));
  if (!orphans.length) return 0;

  const tx = db.transaction('blobs', 'readwrite');
  for (const key of orphans) tx.objectStore('blobs').delete(key);
  await tx.done;
  return orphans.length;
}

/**
 * How the editor's save indicator reads. `offline` means the local write
 * succeeded but the R2 mirror did not; `conflict` means someone else saved this
 * project in the meantime and the push was refused rather than overwriting it.
 */
export type SaveStatus = 'saved' | 'saving' | 'dirty' | 'offline' | 'conflict';
