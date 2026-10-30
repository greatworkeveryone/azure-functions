// The secret in a personal link. 256 bits from the OS random source, shown once (inside the
// email), and never stored: only its SHA-256 is. The token travels in the URL fragment
// (`/t#<token>`), which a browser never sends to a server, so it stays out of access logs.

import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const TOKEN_BYTES = 32;
/** base64url of 32 bytes. */
export const TOKEN_LENGTH = 43;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export const isTokenShaped = (value: unknown): value is string => typeof value === "string" && TOKEN_SHAPE.test(value);

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Constant-time: both are SHA-256 digests, so the lengths always match. */
export function hashesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `${APP_BASE_URL}/t#<token>`. Throws when APP_BASE_URL is not an https (or local http) origin. */
export function linkUrl(token: string, baseUrl: string | undefined = process.env.APP_BASE_URL): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^\s/]+$/i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base)) {
    throw new Error("APP_BASE_URL is not set to the app's origin");
  }
  return `${base}/t#${token}`;
}

export const DEFAULT_EXPIRY_MONTHS = 12;
export const MAX_EXPIRY_MONTHS = 36;

/** Months a new link lasts: the request's, else TENANT_LINK_EXPIRY_MONTHS, else 12. Null when out of range. */
export function expiryMonths(requested: unknown, env: NodeJS.ProcessEnv = process.env): number | null {
  const fallback = Number(env.TENANT_LINK_EXPIRY_MONTHS);
  const base = Number.isInteger(fallback) && fallback >= 1 && fallback <= MAX_EXPIRY_MONTHS ? fallback : DEFAULT_EXPIRY_MONTHS;
  if (requested === undefined || requested === null) return base;
  return Number.isInteger(requested) && (requested as number) >= 1 && (requested as number) <= MAX_EXPIRY_MONTHS ? (requested as number) : null;
}

export function addMonths(from: Date, months: number): Date {
  const out = new Date(from.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}
