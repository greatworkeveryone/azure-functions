export const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB — matches frontend MAX_UPLOAD_BYTES

export const ALLOWED_CONTENT_TYPE_PREFIXES = [
  "image/",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.",
  "text/plain",
];

export function isAllowedContentType(contentType: string): boolean {
  if (contentType === "image/svg+xml") return false;
  return ALLOWED_CONTENT_TYPE_PREFIXES.some((p) => contentType.startsWith(p));
}
