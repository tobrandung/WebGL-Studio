import { callApi, apiErrorMessage, ApiError } from '../storage/api';
import type { Project, ModelEntry } from '../db';

/**
 * Project persistence in R2.
 *
 * IndexedDB alone is not storage you can rely on: Safari drops site data after
 * seven days without a visit and Chrome evicts under pressure, so a project
 * with an hour of keyframe work in it was one cache clear from gone. Syncing
 * also makes projects portable — a colleague opens one and the models come
 * from the CDN, because the document carries content-addressed asset keys
 * rather than local blob ids.
 *
 * Only metadata travels here. The heavy bytes are already in R2 under `a/…`.
 */

export type RemoteProjectSummary = {
  id: string;
  name: string;
  author: string;
  updatedAt: number;
  etag: string;
  size: number;
};

/** What gets stored per project. `remote` is local bookkeeping and is stripped. */
export type ProjectDocument = {
  project: Omit<Project, 'remote'>;
  models: ModelEntry[];
};

export type PushResult = { etag: string; author: string; updatedAt: number };

export async function listRemoteProjects(): Promise<RemoteProjectSummary[]> {
  const response = await callApi('/projects');
  if (!response.ok) {
    throw new ApiError('rejected', await apiErrorMessage(response, 'Projektliste nicht abrufbar.'));
  }
  const body = (await response.json()) as { projects: RemoteProjectSummary[] };
  return body.projects;
}

export async function fetchRemoteProject(
  id: string,
): Promise<{ document: ProjectDocument; etag: string }> {
  const response = await callApi(`/projects/${id}`);
  if (!response.ok) {
    throw new ApiError('rejected', await apiErrorMessage(response, 'Projekt nicht abrufbar.'));
  }
  return {
    document: (await response.json()) as ProjectDocument,
    etag: response.headers.get('etag') ?? '',
  };
}

/**
 * Writes the project, refusing to clobber a version this editor has not seen.
 *
 * `ifMatch` is the ETag the editor last read. Without it the server treats the
 * write as a create and rejects an existing key — which is what keeps two tabs
 * that both think they are new from overwriting each other. A mismatch throws
 * an ApiError of kind `conflict`; the caller is expected to offer a reload
 * rather than retry, because retrying is exactly the silent overwrite the ETag
 * is there to prevent.
 */
export async function pushProject(
  document: ProjectDocument,
  ifMatch?: string,
): Promise<PushResult> {
  const response = await callApi(`/projects/${document.project.id}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(ifMatch ? { 'If-Match': ifMatch } : {}),
    },
    body: JSON.stringify(document),
  });

  if (response.status === 409) {
    const body = (await response.json()) as { error?: string; author?: string };
    throw new ApiError(
      'conflict',
      body.author
        ? `Projekt wurde zwischenzeitlich von ${body.author} geändert.`
        : (body.error ?? 'Projekt wurde zwischenzeitlich woanders geändert.'),
    );
  }
  if (response.status === 413) {
    throw new ApiError('too-large', await apiErrorMessage(response, 'Projekt-Dokument ist zu groß.'));
  }
  if (!response.ok) {
    throw new ApiError('rejected', await apiErrorMessage(response, 'Speichern fehlgeschlagen.'));
  }
  return (await response.json()) as PushResult;
}

export async function deleteRemoteProject(id: string): Promise<void> {
  const response = await callApi(`/projects/${id}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw new ApiError('rejected', await apiErrorMessage(response, 'Löschen fehlgeschlagen.'));
  }
}

/** Strips the local-only sync bookkeeping before sending. */
export function toDocument(project: Project, models: ModelEntry[]): ProjectDocument {
  const { remote: _remote, ...rest } = project;
  return { project: rest, models };
}
