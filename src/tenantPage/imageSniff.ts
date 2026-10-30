// Is this really an image? (TR3) The client's Content-Type is never trusted: the first bytes decide, and
// the file must be well formed from start to end, with no data after the end marker. This is a
// structural check, NOT a re-encode: the backend has no image decoder and no new package may be added,
// so the bytes are stored unchanged in the quarantine container (blob-storage.ts) until a decoder
// exists. Metadata (EXIF, GPS, text chunks) and any appended payload that passes these checks are
// therefore still inside the stored file; nothing serves it.

export type ImageType = "image/jpeg" | "image/png" | "image/webp";

const MAX_SIDE = 16_000;
// 40 MP is about 160 MB decoded at four bytes a pixel: above any phone camera's normal output and below a
// decompression bomb.
const MAX_PIXELS = 40_000_000;
/** Markup that has no business inside a photograph; a file carrying it is an HTML/JS polyglot. */
const MARKUP = /<\s*(script|html|svg|iframe|body|object)\b/i;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const sizeOk = (w: number, h: number): boolean => w > 0 && h > 0 && w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_PIXELS;

function checkPng(b: Buffer): boolean {
  if (b.length < 45 || !b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
  let offset = 8;
  let first = true;
  let sawData = false;
  while (offset + 12 <= b.length) {
    const length = b.readUInt32BE(offset);
    const type = b.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || length > 0x7fffffff || offset + 12 + length > b.length) return false;
    const data = b.subarray(offset + 8, offset + 8 + length);
    if (crc32(b.subarray(offset + 4, offset + 8 + length)) !== b.readUInt32BE(offset + 8 + length)) return false;
    if (first) {
      if (type !== "IHDR" || length !== 13 || !sizeOk(data.readUInt32BE(0), data.readUInt32BE(4))) return false;
      first = false;
    }
    if (type === "IDAT") sawData = true;
    offset += 12 + length;
    if (type === "IEND") return length === 0 && sawData && offset === b.length;
  }
  return false;
}

/**
 * Walks the entropy-coded data after a scan header. Stuffed zeros, fill bytes and restart markers are part
 * of it; the first other marker ends it. Returns the offset of that marker, b.length when it is the end
 * marker at the very end of the file, or -1 when the end marker has anything after it.
 */
function skipEntropyData(b: Buffer, start: number): number {
  let i = start;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const m = b[i + 1];
    if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xff) { i += 1; continue; }
    if (m === 0xd9) return i + 2 === b.length ? b.length : -1;
    return i;
  }
  return -1;
}

function checkJpeg(b: Buffer): boolean {
  if (b.length < 125 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return false;
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return false;
  let offset = 2;
  let sized = false;
  while (offset + 4 <= b.length) {
    if (b[offset] !== 0xff) return false;
    const marker = b[offset + 1];
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xda) {
      if (!sized) return false;
      const scanLength = b.readUInt16BE(offset + 2);
      if (scanLength < 2 || offset + 2 + scanLength > b.length) return false;
      const next = skipEntropyData(b, offset + 2 + scanLength);
      if (next === -1) return false;
      if (next === b.length) return true; // reached the end marker exactly at the end of the file
      offset = next;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = b.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > b.length) return false;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 8) return false;
      if (!sizeOk(b.readUInt16BE(offset + 7), b.readUInt16BE(offset + 5))) return false;
      sized = true;
    }
    offset += 2 + length;
  }
  return false;
}

function webpSizeOk(b: Buffer, kind: string): boolean {
  if (kind === "VP8X") return sizeOk(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return false;
    const bits = b.readUInt32LE(21);
    return sizeOk((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return false;
  return sizeOk(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
}

function checkWebp(b: Buffer): boolean {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return false;
  if (b.readUInt32LE(4) + 8 !== b.length) return false;
  const first = b.toString("latin1", 12, 16);
  if (!["VP8 ", "VP8L", "VP8X"].includes(first)) return false;
  if (!webpSizeOk(b, first)) return false;
  let offset = 12;
  while (offset + 8 <= b.length) {
    const size = b.readUInt32LE(offset + 4);
    offset += 8 + size + (size & 1);
  }
  return offset === b.length;
}

/** The image type the bytes really are, or null when they are not a well-formed JPEG, PNG or WebP. */
export function sniffImage(bytes: Buffer): ImageType | null {
  if (MARKUP.test(bytes.toString("latin1"))) return null;
  if (checkJpeg(bytes)) return "image/jpeg";
  if (checkPng(bytes)) return "image/png";
  if (checkWebp(bytes)) return "image/webp";
  return null;
}
