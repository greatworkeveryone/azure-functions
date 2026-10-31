/// <reference types="jest" />
import { _resetRateLimitForTests, checkRateLimit, isRateLimitFull, checkSignInRateLimit, SIGN_IN_LIMITS } from "./rateLimit";

// SEC-10: sign-in is limited per user (20/min) with a generous per-IP ceiling
// (120/min) so a shared office NAT is never locked out by its own staff, and
// the IP is the one the platform saw, not a header the caller wrote (that rule
// is access/clientIp.ts clientAddress, tested in registerSelf.rateLimit.test.ts).

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

describe("which bucket refused", () => {
  it("names the user bucket when one person is over their own limit", () => {
    for (let i = 0; i < SIGN_IN_LIMITS.perOid.limit; i++) checkSignInRateLimit("oid-a", "ip");
    expect(checkSignInRateLimit("oid-a", "ip")).toMatchObject({ allowed: false, bucket: "user" });
  });

  it("names the address bucket when a whole address is over its limit", () => {
    for (let i = 0; i < SIGN_IN_LIMITS.perIp.limit; i++) checkSignInRateLimit(`oid-${i % 30}`, "ip");
    expect(checkSignInRateLimit("oid-new", "ip")).toMatchObject({ allowed: false, bucket: "address" });
  });
});

describe("a refused call does not extend the window (P4)", () => {
  const T0 = 1_800_000_000_000;
  let now: jest.SpyInstance;
  beforeEach(() => {
    now = jest.spyOn(Date, "now").mockReturnValue(T0);
  });
  afterEach(() => now.mockRestore());

  it("keeps the first window's end however often the caller retries", () => {
    for (let i = 0; i < SIGN_IN_LIMITS.perOid.limit; i++) checkSignInRateLimit("oid-a", "ip");

    now.mockReturnValue(T0 + 10_000);
    expect(checkSignInRateLimit("oid-a", "ip")).toMatchObject({ allowed: false, retryAfterMs: 50_000 });
    now.mockReturnValue(T0 + 30_000);
    expect(checkSignInRateLimit("oid-a", "ip")).toMatchObject({ allowed: false, retryAfterMs: 30_000 });
    now.mockReturnValue(T0 + 59_999);
    expect(checkSignInRateLimit("oid-a", "ip")).toMatchObject({ allowed: false, retryAfterMs: 1 });

    now.mockReturnValue(T0 + 60_000);
    expect(checkSignInRateLimit("oid-a", "ip").allowed).toBe(true);
  });

  it("does not count refused calls toward the next window either", () => {
    for (let i = 0; i < SIGN_IN_LIMITS.perOid.limit; i++) checkSignInRateLimit("oid-a", "ip");
    for (let i = 0; i < 50; i++) checkSignInRateLimit("oid-a", "ip");

    now.mockReturnValue(T0 + 60_000);
    for (let i = 0; i < SIGN_IN_LIMITS.perOid.limit; i++) {
      expect(checkSignInRateLimit("oid-a", "ip").allowed).toBe(true);
    }
    expect(checkSignInRateLimit("oid-a", "ip").allowed).toBe(false);
  });

  it("holds for the plain limiter too", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("k", { limit: 3, windowMs: 1000 });
    now.mockReturnValue(T0 + 900);
    expect(checkRateLimit("k", { limit: 3, windowMs: 1000 })).toEqual({ allowed: false, retryAfterMs: 100 });
    now.mockReturnValue(T0 + 1000);
    expect(checkRateLimit("k", { limit: 3, windowMs: 1000 }).allowed).toBe(true);
  });
});

describe("isRateLimitFull", () => {
  it("peeks without counting: only checkRateLimit hits fill the bucket", () => {
    const opts = { limit: 2, windowMs: 60_000 };
    for (let i = 0; i < 5; i += 1) expect(isRateLimitFull("peek", opts).allowed).toBe(true);
    checkRateLimit("peek", opts);
    checkRateLimit("peek", opts);
    expect(isRateLimitFull("peek", opts).allowed).toBe(false);
  });
});

describe("the key cap", () => {
  it("keeps memory bounded when far more keys arrive than the cap, and still answers", () => {
    for (let i = 0; i < 20_500; i += 1) expect(checkRateLimit(`flood:${i}`, { limit: 1, windowMs: 60_000 }).allowed).toBe(true);
    expect(checkRateLimit("flood:fresh", { limit: 1, windowMs: 60_000 }).allowed).toBe(true);
  });
});
