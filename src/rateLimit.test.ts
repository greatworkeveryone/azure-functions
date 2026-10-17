/// <reference types="jest" />
import { _resetRateLimitForTests, checkSignInRateLimit, clientIpFromHeaders, SIGN_IN_LIMITS } from "./rateLimit";

// SEC-10: sign-in is limited per user (20/min) with a generous per-IP ceiling
// (120/min) so a shared office NAT is never locked out by its own staff, and
// the IP is the one the platform saw, not a header the caller wrote.

const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()] ?? null;

beforeEach(() => _resetRateLimitForTests());

describe("checkSignInRateLimit", () => {
  it("allows 20 sign-ins a minute per user, then refuses that user only", () => {
    for (let i = 0; i < SIGN_IN_LIMITS.perOid.limit; i++) {
      expect(checkSignInRateLimit("oid-a", "203.0.113.5").allowed).toBe(true);
    }
    expect(checkSignInRateLimit("oid-a", "203.0.113.5").allowed).toBe(false);
    expect(checkSignInRateLimit("oid-b", "203.0.113.5").allowed).toBe(true);
  });

  it("lets a whole office share one IP up to 120 a minute", () => {
    for (let i = 0; i < SIGN_IN_LIMITS.perIp.limit; i++) {
      expect(checkSignInRateLimit(`oid-${i % 30}`, "203.0.113.5").allowed).toBe(true);
    }
    expect(checkSignInRateLimit("oid-new", "203.0.113.5").allowed).toBe(false);
    expect(checkSignInRateLimit("oid-new", "198.51.100.7").allowed).toBe(true);
  });

  it("does not spend the office's IP budget on a user already over their own limit", () => {
    for (let i = 0; i < 40; i++) checkSignInRateLimit("oid-loop", "203.0.113.5");
    let allowed = 0;
    for (let i = 0; i < SIGN_IN_LIMITS.perIp.limit; i++) {
      if (checkSignInRateLimit(`oid-${i % 50}`, "203.0.113.5").allowed) allowed++;
    }
    expect(allowed).toBe(SIGN_IN_LIMITS.perIp.limit - SIGN_IN_LIMITS.perOid.limit);
  });

  it("reports when to retry", () => {
    for (let i = 0; i < SIGN_IN_LIMITS.perOid.limit; i++) checkSignInRateLimit("oid-a", "ip");
    const res = checkSignInRateLimit("oid-a", "ip");
    expect(res.allowed).toBe(false);
    expect(res.allowed === false && res.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("clientIpFromHeaders", () => {
  // Same rule as the access log / money gate (lane S, clientAddress): the
  // rightmost PUBLIC entry, unreadable entries skipped.
  it("takes the hop the platform appended, not the caller's first entry", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "198.51.100.77, 203.0.113.5" }))).toBe("203.0.113.5");
  });

  it("skips private hops the platform added after the client", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "203.0.113.5, 10.1.2.3, 169.254.0.9" }))).toBe("203.0.113.5");
  });

  it("skips entries that are not addresses", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "203.0.113.5, nonsense, office" }))).toBe("203.0.113.5");
  });

  it("drops ports and brackets and unwraps IPv4-mapped IPv6", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "203.0.113.5:61234" }))).toBe("203.0.113.5");
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "[2001:DB8::1]:443" }))).toBe("2001:db8::1");
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "::ffff:203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("falls back to the rightmost address when none is public, then to unknown", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "127.0.0.1" }))).toBe("127.0.0.1");
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "junk" }))).toBe("unknown");
    expect(clientIpFromHeaders(headers({ "x-azure-clientip": "198.51.100.7" }))).toBe("unknown");
    expect(clientIpFromHeaders(headers({}))).toBe("unknown");
  });
});
