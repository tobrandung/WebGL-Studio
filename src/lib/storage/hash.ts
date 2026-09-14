/**
 * Content-addressed key for a blob, plus the digest R2 verifies it against.
 *
 * 64 bits of SHA-256 in the key is short enough to keep URLs readable and long
 * enough that a collision across an agency's lifetime of assets is not a thing
 * that happens. The *full* digest travels alongside as `checksum`: the Worker
 * signs it into the upload, so R2 rejects a body that does not hash to it, and
 * the Worker separately checks that it agrees with the key. Together that makes
 * "the name is the hash of the content" something the storage enforces rather
 * than something the client promises.
 *
 * The payoff of addressing by content is unchanged: re-exporting an unchanged
 * project uploads nothing and invalidates nothing — same bytes, same key,
 * already cached at the edge.
 */
export type ContentAddress = {
  /** Storage key, e.g. `a/1a2b3c4d5e6f7a8b.glb`. */
  key: string;
  /** Full SHA-256 as base64 — the wire format of `x-amz-checksum-sha256`. */
  checksum: string;
};

export async function contentAddress(
  data: ArrayBuffer,
  extension: string,
): Promise<ContentAddress> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));

  const hex = Array.from(digest.subarray(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);

  return { key: `a/${hex}.${extension.toLowerCase()}`, checksum: btoa(binary) };
}
