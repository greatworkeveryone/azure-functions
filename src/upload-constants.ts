export const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB — matches frontend MAX_UPLOAD_BYTES

// Exact allowlist (no prefixes): nothing that can render script, e.g. SVG or HTML.
export const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/bmp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
]);

// Strips parameters ("; charset=utf-8") and case so the allowlist sees the bare media type.
export function normaliseMediaType(raw: string): string {
  return (raw ?? "").split(";")[0].trim().toLowerCase();
}

export function isAllowedContentType(raw: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(normaliseMediaType(raw));
}

// Only these may render inline in the browser; everything else downloads.
export function isInlineSafeType(raw: string): boolean {
  const t = normaliseMediaType(raw);
  return ALLOWED_CONTENT_TYPES.has(t) && (t.startsWith("image/") || t === "application/pdf");
}

function startsWithBytes(buf: Buffer, sig: number[], offset = 0): boolean {
  return sig.every((b, i) => buf[offset + i] === b);
}

// Magic-byte check for image/* and PDF; other allowed types are not sniffed.
export function bytesMatchMediaType(raw: string, buf: Buffer): boolean {
  const t = normaliseMediaType(raw);
  switch (t) {
    case "image/jpeg": return startsWithBytes(buf, [0xff, 0xd8, 0xff]);
    case "image/png": return startsWithBytes(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/gif": return ["GIF87a", "GIF89a"].includes(buf.subarray(0, 6).toString("latin1"));
    case "image/webp": return buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
    case "image/bmp": return buf.subarray(0, 2).toString("latin1") === "BM";
    case "image/tiff": return startsWithBytes(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWithBytes(buf, [0x4d, 0x4d, 0x00, 0x2a]);
    case "image/heic":
    case "image/heif": return buf.subarray(4, 8).toString("latin1") === "ftyp";
    case "application/pdf": return buf.subarray(0, 1024).toString("latin1").includes("%PDF-");
    default: return true;
  }
}
