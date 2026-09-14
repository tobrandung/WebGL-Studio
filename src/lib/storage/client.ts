import { callApi, apiErrorMessage, ApiError } from './api';
import { isHostingConfigured } from './config';
import { contentAddress } from './hash';
import { MAX_UPLOAD_BYTES } from './asset-key';
import type { AssetInput, AssetRef, UploadProgress } from './types';

type SignResponse = {
  uploadUrl: string;
  headers: Record<string, string>;
  publicUrl: string;
};

/**
 * Does this content hash already exist, and where is it served from?
 *
 * Exported because the export dialog calls it on open for every asset whose
 * `assetKey` is already recorded: that turns "reopen the dialog" into a
 * handful of tiny requests instead of a re-upload, and it also catches the case
 * where an asset was published from another machine.
 */
export async function lookupAsset(key: string): Promise<{ exists: boolean; publicUrl: string }> {
  const response = await callApi(`/sign?key=${encodeURIComponent(key)}`);
  if (!response.ok) {
    throw new ApiError('rejected', await apiErrorMessage(response, 'Abfrage fehlgeschlagen.'));
  }
  return (await response.json()) as { exists: boolean; publicUrl: string };
}

/**
 * Uploads with XMLHttpRequest rather than fetch: fetch cannot report upload
 * progress, and a 50 MB model on agency office upstream is long enough that a
 * dialog without a progress bar looks broken.
 */
function putWithProgress(
  signed: SignResponse,
  data: ArrayBuffer,
  onProgress?: UploadProgress,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signed.uploadUrl, true);
    // Exactly the headers that were signed. Any deviation. Including a missing
    // one. Makes R2 answer 403 SignatureDoesNotMatch. Content-Length is set by
    // the browser from the body and is covered by the same signature, which is
    // what enforces the size ceiling server-side.
    for (const [name, value] of Object.entries(signed.headers)) {
      if (name.toLowerCase() === 'content-length') continue;
      xhr.setRequestHeader(name, value);
    }

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(
        new ApiError(
          'rejected',
          xhr.status === 403
            ? 'R2 hat den Upload abgelehnt (Signatur abgelaufen oder Header weichen ab). Bitte erneut versuchen.'
            : xhr.status === 400
              ? 'R2 hat den Upload abgelehnt: die übertragenen Daten passen nicht zur Prüfsumme. Bitte erneut versuchen.'
              : `Upload fehlgeschlagen: HTTP ${xhr.status}`,
        ),
      );
    };
    xhr.onerror = () =>
      reject(
        new ApiError(
          'network',
          'Upload abgebrochen. Netzwerkfehler oder CORS-Regel des Buckets fehlt.',
        ),
      );
    xhr.onabort = () => reject(new ApiError('network', 'Upload abgebrochen.'));

    xhr.send(data);
  });
}

/**
 * Stores one blob and returns its public URL, skipping the transfer when the
 * same bytes are already there.
 */
export async function uploadAsset(
  input: AssetInput,
  onProgress?: UploadProgress,
): Promise<AssetRef> {
  if (!isHostingConfigured()) {
    throw new ApiError('not-configured', 'Hosting ist in diesem Build deaktiviert.');
  }
  if (input.data.byteLength > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      'too-large',
      `Datei ist ${(input.data.byteLength / 1024 / 1024).toFixed(1)} MB groß. Erlaubt sind ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Erst über „Optimieren“ verkleinern.`,
    );
  }

  const { key, checksum } = await contentAddress(input.data, input.extension);

  const known = await lookupAsset(key);
  if (known.exists) return { key, url: known.publicUrl, skipped: true };

  const signResponse = await callApi('/sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      key,
      contentType: input.contentType,
      size: input.data.byteLength,
      checksum,
    }),
  });
  if (!signResponse.ok) {
    const message = await apiErrorMessage(signResponse, `Signatur fehlgeschlagen (${signResponse.status}).`);
    throw new ApiError(signResponse.status === 413 ? 'too-large' : 'rejected', message);
  }

  const signed = (await signResponse.json()) as SignResponse;
  await putWithProgress(signed, input.data, onProgress);
  return { key, url: signed.publicUrl, skipped: false };
}

/** Who we are, according to Cloudflare Access. Null when hosting is off. */
export async function fetchIdentity(): Promise<string | null> {
  if (!isHostingConfigured()) return null;
  try {
    const response = await callApi('/me');
    if (!response.ok) return null;
    const body = (await response.json()) as { name?: string };
    return body.name ?? null;
  } catch {
    return null;
  }
}
