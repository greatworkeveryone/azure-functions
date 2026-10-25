import { createHmac } from "node:crypto";
import { BlockList, isIP, isIPv4 } from "node:net";
import { isDevOverrideEnabled } from "../jwt";
import { Sentry } from "../sentry";

// The caller's network address, for the access log (S10) and the money gate
// (S11). Azure Functions puts the client address in X-Forwarded-For. The header
// is unverified: a caller can send its own, and a proxy that appends (rather
// than overwrites) leaves the caller's value on the LEFT and the address it
// actually saw on the right. So the address we trust is the rightmost public
// one: a caller cannot place anything to the right of the platform's entry,
// and well-formed private hops the platform adds after it are skipped. If the
// platform overwrites the header there is one entry and this is that entry.
//
// It fails closed. Walking from the right, the first entry we cannot read
// (an unbracketed IPv6 with a port, "unknown", an obfuscated RFC 7239 name, an
// empty slot, a zone id) ends the walk with null: we cannot tell whether that
// entry was the platform's, so nothing to its left may be trusted. A header
// with no public address is null too. Null means "refused" to the money gate.
// /api/health?deep=true logs the header's shape so this can be confirmed from
// the office (see docs/runbooks/monitoring.md §3).

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

/** One X-Forwarded-For entry as a canonical address, or null when it is not
 *  exactly one readable address. */
function normaliseEntry(raw: string): string | null {
  let entry = raw.trim().replace(/^"|"$/g, "");
  if (!entry || entry.includes("%")) return null;
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

/** The rightmost public address in X-Forwarded-For, skipping well-formed
 *  private hops. Null (refuse) when the header is missing, when an entry is
 *  unreadable before a public address is reached, or when none is public. */
export function clientAddress(request: HeaderSource): string | null {
  const header = request.headers.get("x-forwarded-for");
  if (!header || header.trim() === "") return null;
  const raw = header.split(",");
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const entry = normaliseEntry(raw[i]);
    if (entry === null) return null;
    if (isPublicAddress(entry)) return entry;
  }
  return null;
}

/** The header's shape without the address itself, for the health probe log. */
export function forwardedSummary(request: HeaderSource): {
  clientIpHeader: boolean;
  entries: number;
  forwardedFor: boolean;
  unreadable: number;
} {
  const header = request.headers.get("x-forwarded-for");
  const total = header && header.trim() !== "" ? header.split(",").length : 0;
  const entries = parseForwardedFor(header).length;
  return {
    clientIpHeader: request.headers.get("x-client-ip") !== null,
    entries,
    forwardedFor: total > 0,
    unreadable: total - entries,
  };
}

// Without a key the hash is still stable and not the raw value, but an IPv4
// address can be recovered by trying all 2^32 of them. ACCESS_HASH_KEY (a
// random secret, Key Vault) closes that; rotating it breaks device continuity
// for 90 days, so rotate only on a leak. The fallback keeps the access log
// working: silent in local dev, one Sentry warning per process elsewhere.
const FALLBACK_KEY = "floorplan-access-v1";
let warnedFallback = false;

function hashKey(): string {
  const key = process.env.ACCESS_HASH_KEY?.trim();
  if (key) return key;
  if (!warnedFallback && !isDevOverrideEnabled()) {
    warnedFallback = true;
    Sentry.captureMessage("ACCESS_HASH_KEY is unset: access-log hashes use the public fallback key", "warning");
  }
  return FALLBACK_KEY;
}

/** Keyed SHA-256 of an address or user agent: 32 hex characters. */
export function hashValue(kind: "ip" | "ua", value: string): string {
  return createHmac("sha256", hashKey()).update(`${kind}:${value}`).digest("hex").slice(0, 32);
}
