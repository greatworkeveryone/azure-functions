// Refuse zip bombs before ExcelJS sees an upload (sprint F, code review 2).
//
// ExcelJS (through JSZip) inflates every entry of an .xlsx fully into memory
// before any row cap applies: a 206 KB upload grew a Function by 753 MB. This
// walks the zip's central directory and inflates each entry here, with zlib's
// maxOutputLength, under a per-entry and a total cap. Declared sizes are not
// trusted; only bytes actually produced count. If it passes, the original
// buffer goes to ExcelJS, which can then produce no more than was measured.
// No dependency beyond node:zlib.

import { inflateRawSync } from "node:zlib";

export class XlsxRejectedError extends Error {}

export interface XlsxLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_XLSX_LIMITS: XlsxLimits = {
  maxEntries: 200,
  maxEntryBytes: 30 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
};

const TOO_LARGE = "The spreadsheet is too large once unpacked";
const UNREADABLE = "That file isn't a readable .xlsx spreadsheet";
const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEnd(buffer: Buffer): number {
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) === END_SIGNATURE) return at;
  }
  throw new XlsxRejectedError(UNREADABLE);
}

function inflatedSize(data: Buffer, method: number, cap: number): number {
  if (method === 0) return data.length;
  if (method !== 8) throw new XlsxRejectedError(UNREADABLE);
  try {
    return inflateRawSync(data, { maxOutputLength: cap }).length;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) throw new XlsxRejectedError(TOO_LARGE);
    throw new XlsxRejectedError(UNREADABLE);
  }
}

/** Throws XlsxRejectedError unless every entry unpacks within the limits. */
export function assertSafeXlsx(buffer: Buffer, limits: XlsxLimits = DEFAULT_XLSX_LIMITS): void {
  if (buffer.length < 22) throw new XlsxRejectedError(UNREADABLE);
  const end = findEnd(buffer);
  const count = buffer.readUInt16LE(end + 10);
  if (count > limits.maxEntries) throw new XlsxRejectedError(TOO_LARGE);
  const directoryStart = buffer.readUInt32LE(end + 16);
  // The directory must end exactly at the end record and hold exactly the entries it declares:
  // JSZip reads every central entry it finds, and shifts offsets when there are bytes before the zip.
  if (buffer.readUInt16LE(end + 8) !== count || directoryStart + buffer.readUInt32LE(end + 12) !== end) throw new XlsxRejectedError(UNREADABLE);
  let cursor = directoryStart;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new XlsxRejectedError(UNREADABLE);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const local = buffer.readUInt32LE(cursor + 42);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    cursor += 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    if (compressed === 0xffffffff || local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
      throw new XlsxRejectedError(UNREADABLE);
    }
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressed > buffer.length) throw new XlsxRejectedError(UNREADABLE);
    const cap = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - total);
    const size = inflatedSize(buffer.subarray(start, start + compressed), method, cap + 1);
    if (size > cap) throw new XlsxRejectedError(TOO_LARGE);
    total += size;
  }
  if (cursor !== end) throw new XlsxRejectedError(UNREADABLE);
}
