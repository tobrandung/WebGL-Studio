/**
 * Content-addressed key for a blob.
 *
 * 64 bits of SHA-256 is short enough to keep URLs readable and long enough that
 * a collision across an agency's lifetime of assets is not a thing that
 * happens. Truncating rather than using the full digest is safe here because
 * the hash is an identifier, not a security boundary — nothing trusts a file
 * because of its name.
 *
 * The payoff is that re-exporting an unchanged project uploads nothing and
 * invalidates nothing: same bytes, same key, already cached at the edge.
 */
export async function contentKey(data: ArrayBuffer, extension: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest).subarray(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `a/${hex}.${extension.toLowerCase()}`;
}
