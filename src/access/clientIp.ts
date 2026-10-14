import { createHmac } from "node:crypto";
import { BlockList, isIP, isIPv4 } from "node:net";

// The caller's network address, for the access log (S10) and the money gate
// (S11). Azure Functions puts the client address in X-Forwarded-For. The header
// is unverified: a caller can send its own, and a proxy that appends (rather
// than overwrites) leaves the caller's value on the LEFT and the address it
// actually saw on the right. So the address we trust is the rightmost public
// one: a caller cannot place anything to the right of the platform's entry,
// and private hops the platform adds after it are skipped. If the platform
// overwrites the header there is one entry and this is simply that entry.
// /api/health?deep=true logs the header's shape so this can be confirmed from
// the office (see docs/runbooks/monitoring.md).

interface HeaderSource {
  headers: { get(name: string): string | null };
}

const NOT_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  NOT_PUBLIC.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  NOT_PUBLIC.addSubnet(net, prefix, "ipv6");
}

const BRACKETED = /^\[([^\]]+)\](?::\d+)?$/;
const V4_WITH_PORT = /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/;
const V4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function normaliseEntry(raw: string): string | null {
  let entry = raw.trim().replace(/^"|"$/g, "");
  if (!entry) return null;
  const bracketed = entry.match(BRACKETED);
  if (bracketed) entry = bracketed[1];
  else if (V4_WITH_PORT.test(entry)) entry = entry.slice(0, entry.lastIndexOf(":"));
  const mapped = entry.match(V4_MAPPED);
  if (mapped) entry = mapped[1];
  if (!isIP(entry)) return null;
  return isIPv4(entry) ? entry : entry.toLowerCase();
}

/** Every well-formed address in an X-Forwarded-For value, in header order. */
export function parseForwardedFor(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map(normaliseEntry)
    .filter((entry): entry is string => entry !== null);
}

export function isPublicAddress(address: string): boolean {
  const family = isIPv4(address) ? "ipv4" : "ipv6";
  return !NOT_PUBLIC.check(address, family);
}

/** The rightmost public address in X-Forwarded-For (else the rightmost one),
 *  or null when the header is missing or unreadable. */
export function clientAddress(request: HeaderSource): string | null {
  const entries = parseForwardedFor(request.headers.get("x-forwarded-for"));
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (isPublicAddress(entries[i])) return entries[i];
  }
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

/** The header's shape without the address itself, for the health probe log. */
export function forwardedSummary(request: HeaderSource): {
  clientIpHeader: boolean;
  entries: number;
  forwardedFor: boolean;
} {
  const header = request.headers.get("x-forwarded-for");
  return {
    clientIpHeader: request.headers.get("x-client-ip") !== null,
    entries: parseForwardedFor(header).length,
    forwardedFor: header !== null && header.trim() !== "",
  };
}

// Without a key the hash is still stable and not the raw value, but an IPv4
// address can be recovered by trying all 2^32 of them. ACCESS_HASH_KEY (a
// random secret, Key Vault) closes that; rotating it breaks device continuity
// for 90 days, so rotate only on a leak.
const FALLBACK_KEY = "floorplan-access-v1";

/** Keyed SHA-256 of an address or user agent: 32 hex characters. */
export function hashValue(kind: "ip" | "ua", value: string): string {
  const key = process.env.ACCESS_HASH_KEY?.trim() || FALLBACK_KEY;
  return createHmac("sha256", key).update(`${kind}:${value}`).digest("hex").slice(0, 32);
}
