import { getDB, environmentFormat, type EnvironmentConfig, type ModelEntry } from '../db';
import { uploadAsset } from '../storage/client';
import { ApiError } from '../storage/api';
import { isHostingConfigured } from '../storage/config';
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from '../storage/asset-key';
import { ENVIRONMENT_CONTENT_TYPE, extensionForFormat } from '../hdri/format';
import { formatBytes } from '../utils';

/**
 * Publishing a project's assets, without waiting for an export.
 *
 * The export dialog has always uploaded models and environments to R2, and that
 * used to be the only thing that ever did. Which meant a project was shared
 * metadata pointing at bytes only its author's browser had: the document synced,
 * the scene opened empty for everyone else, and each colleague had to be handed
 * the files by other means. So the upload moved here, off the export path,
 * and the editor runs it as soon as an asset exists.
 *
 * Nothing about the mechanics changed. Assets are content-addressed, so a file a
 * colleague already published costs a lookup and no transfer, and the resulting
 * `assetKey` on the record is what `loadBlob` resolves against the CDN.
 */

export type PublishFailure = {
  /** Model id, or the environment's blob id. */
  id: string;
  label: string;
  reason: string;
};

export type PublishResult = {
  /** Model id → the key it was published under. Only newly resolved ones. */
  modelKeys: Record<string, string>;
  environmentKey: string | null;
  failures: PublishFailure[];
  /** The team storage budget is used up; nothing more will fit right now. */
  quotaExceeded: boolean;
};

const EMPTY: PublishResult = {
  modelKeys: {},
  environmentKey: null,
  failures: [],
  quotaExceeded: false,
};

function modelExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : 'glb';
}

/** Everything the CDN can serve is a GLB; a .gltf with side files is not one file. */
function modelContentType(fileName: string): string | null {
  return modelExtension(fileName) === 'glb' ? 'model/gltf-binary' : null;
}

/**
 * Whether anything is left to publish, as a stable string.
 *
 * A string rather than a count so an effect can depend on *which* assets are
 * pending: the editor's `models` array gets a new identity on every transform
 * save, and re-running the upload pass for that would be a lot of hashing.
 */
export function pendingAssetKey(
  models: ModelEntry[],
  environment: EnvironmentConfig | null | undefined,
): string {
  const ids = models.filter((m) => !m.assetKey).map((m) => m.id);
  if (environment && !environment.assetKey) ids.push(environment.blobId);
  return ids.sort().join(',');
}

type Target = {
  id: string;
  label: string;
  contentType: string | null;
  extension: string;
  persist: (key: string) => Promise<void>;
};

/**
 * Uploads every asset of this project that does not yet carry an `assetKey` and
 * records the key on its own record.
 *
 * Failures are collected rather than thrown: one oversized model must not keep
 * the other four out of the team's reach. The common case, a project imported
 * from R2 whose bytes this browser never had, is not a failure at all. There is
 * simply nothing to do.
 */
export async function publishPendingAssets(projectId: string): Promise<PublishResult> {
  if (!isHostingConfigured()) return EMPTY;

  const db = await getDB();
  const project = await db.get('projects', projectId);
  if (!project) return EMPTY;

  const models = await db.getAllFromIndex('models', 'by-project', projectId);
  const targets: Target[] = models
    .filter((model) => !model.assetKey)
    .map((model) => ({
      id: model.id,
      label: model.name || model.fileName,
      contentType: modelContentType(model.fileName),
      extension: modelExtension(model.fileName),
      persist: async (key) => {
        // Re-read: an autosave may have written a new transform onto this
        // record while the upload was in flight.
        const current = await db.get('models', model.id);
        if (current) await db.put('models', { ...current, assetKey: key });
      },
    }));

  const environment = project.environment;
  if (environment && !environment.assetKey) {
    const format = environmentFormat(environment);
    targets.push({
      id: environment.blobId,
      label: environment.fileName,
      contentType: ENVIRONMENT_CONTENT_TYPE[format],
      // extensionForFormat includes the dot; the key grammar does not.
      extension: extensionForFormat(format).slice(1),
      persist: async (key) => {
        const current = await db.get('projects', projectId);
        if (current?.environment) {
          await db.put('projects', {
            ...current,
            environment: { ...current.environment, assetKey: key },
          });
        }
      },
    });
  }

  const result: PublishResult = {
    modelKeys: {},
    environmentKey: null,
    failures: [],
    quotaExceeded: false,
  };

  for (const target of targets) {
    // No local bytes: the project came from the team storage and was never
    // published, so there is nothing here to upload. Deliberately not reported
    // as a failure, because the editor already says the model could not be
    // loaded and a second banner repeating it per asset only buries the first.
    const blob = await db.get('blobs', target.id);
    if (!blob) continue;
    if (!target.contentType || !ALLOWED_CONTENT_TYPES.has(target.contentType)) {
      result.failures.push({
        id: target.id,
        label: target.label,
        reason: 'Dieses Dateiformat kann nicht veröffentlicht werden.',
      });
      continue;
    }
    if (blob.data.byteLength > MAX_UPLOAD_BYTES) {
      result.failures.push({
        id: target.id,
        label: target.label,
        reason: `${formatBytes(blob.data.byteLength)} überschreiten das Limit von ${formatBytes(MAX_UPLOAD_BYTES)}. Erst über „Optimieren“ verkleinern.`,
      });
      continue;
    }

    try {
      const ref = await uploadAsset({
        data: blob.data,
        contentType: target.contentType,
        extension: target.extension,
      });
      await target.persist(ref.key);
      if (target.id === environment?.blobId) result.environmentKey = ref.key;
      else result.modelKeys[target.id] = ref.key;
    } catch (err) {
      result.failures.push({ id: target.id, label: target.label, reason: (err as Error).message });
      // A full bucket is not this file's problem, it is every remaining file's.
      // Trying the rest would only produce the same refusal four more times and
      // bury the one message that matters under duplicates of itself.
      if (err instanceof ApiError && err.kind === 'quota-exceeded') {
        result.quotaExceeded = true;
        break;
      }
    }
  }

  return result;
}
