/**
 * OpenEXR header probe: reads the image dimensions and the interesting version
 * flags out of the first few KB, without decoding anything.
 *
 * The upload dialog needs width and height to show its size warning and pick a
 * recommendation. Decoding first would mean allocating up to 256 MB before we
 * can say "this file is too large". Which is exactly the case the warning
 * exists for. Pure, no imports.
 */

const MAGIC = 0x01312f76;
const MAX_HEADER_BYTES = 1 << 16;

export type ExrProbe = {
  width: number;
  height: number;
  /** Tiled, deep or multi-part files take different paths in `EXRLoader`. */
  unusual: boolean;
  note?: string;
};

function readNullTerminated(view: DataView, offset: number, limit: number): { text: string; next: number } {
  let end = offset;
  while (end < limit && view.getUint8(end) !== 0) end++;
  let text = '';
  for (let i = offset; i < end; i++) text += String.fromCharCode(view.getUint8(i));
  return { text, next: end + 1 };
}

/** Returns null when the buffer is not an EXR or the header is truncated. */
export function probeEXR(bytes: Uint8Array): ExrProbe | null {
  if (bytes.byteLength < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) return null;

  const version = view.getUint32(4, true);
  const tiled = (version & 0x200) !== 0;
  const deep = (version & 0x800) !== 0;
  const multiPart = (version & 0x1000) !== 0;

  const limit = Math.min(bytes.byteLength, MAX_HEADER_BYTES);
  let offset = 8;
  let width = 0;
  let height = 0;
  let lineOrder = 0;

  while (offset < limit) {
    const name = readNullTerminated(view, offset, limit);
    if (!name.text) break; // empty name terminates the header
    const type = readNullTerminated(view, name.next, limit);
    if (type.next + 4 > limit) return null;
    const size = view.getInt32(type.next, true);
    const dataStart = type.next + 4;
    if (size < 0 || dataStart + size > limit) return null;

    if (name.text === 'dataWindow' && type.text === 'box2i' && size >= 16) {
      const xMin = view.getInt32(dataStart, true);
      const yMin = view.getInt32(dataStart + 4, true);
      const xMax = view.getInt32(dataStart + 8, true);
      const yMax = view.getInt32(dataStart + 12, true);
      width = xMax - xMin + 1;
      height = yMax - yMin + 1;
    } else if (name.text === 'lineOrder' && size >= 1) {
      lineOrder = view.getUint8(dataStart);
    }

    offset = dataStart + size;
    if (width > 0 && height > 0 && offset >= limit) break;
  }

  if (width <= 0 || height <= 0) return null;

  const notes: string[] = [];
  if (tiled) notes.push('tiled');
  if (deep) notes.push('deep');
  if (multiPart) notes.push('multi-part');
  if (lineOrder === 2) notes.push('random line order');

  return {
    width,
    height,
    unusual: notes.length > 0,
    note: notes.length ? notes.join(', ') : undefined,
  };
}
