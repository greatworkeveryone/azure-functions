import { clientAddress, forwardedSummary, hashValue, parseForwardedFor } from "./clientIp";

function req(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (name: string) => lower[name.toLowerCase()] ?? null } };
}

describe("parseForwardedFor", () => {
  it("trims, drops ports and brackets, and skips junk", () => {
    expect(parseForwardedFor(" 203.0.113.5:54321 , [2001:db8::1]:443, nonsense, 10.0.0.4 ")).toEqual([
      "203.0.113.5",
      "2001:db8::1",
      "10.0.0.4",
    ]);
  });

  it("unwraps IPv4-mapped IPv6", () => {
    expect(parseForwardedFor("::ffff:203.0.113.9")).toEqual(["203.0.113.9"]);
  });

  it("returns nothing for a missing or empty header", () => {
    expect(parseForwardedFor(null)).toEqual([]);
    expect(parseForwardedFor("  ")).toEqual([]);
  });
});

describe("clientAddress", () => {
  it("takes the only address when the platform overwrites the header", () => {
    expect(clientAddress(req({ "x-forwarded-for": "203.0.113.5:61000" }))).toBe("203.0.113.5");
  });

  it("ignores an address the caller prepended and keeps the one the platform appended", () => {
    // A caller can send its own X-Forwarded-For; a proxy that appends puts the
    // real peer last, so the leftmost entry is attacker-controlled.
    expect(clientAddress(req({ "x-forwarded-for": "198.51.100.77, 203.0.113.5" }))).toBe("203.0.113.5");
  });

  it("skips private hops the platform added after the client", () => {
    expect(clientAddress(req({ "x-forwarded-for": "203.0.113.5, 10.1.2.3, 169.254.0.9" }))).toBe("203.0.113.5");
  });

  it("falls back to the rightmost address when none is public (local development)", () => {
    expect(clientAddress(req({ "x-forwarded-for": "127.0.0.1" }))).toBe("127.0.0.1");
  });

  it("is null without the header", () => {
    expect(clientAddress(req({}))).toBeNull();
  });
});

describe("forwardedSummary", () => {
  it("reports presence and shape, never the address", () => {
    const summary = forwardedSummary(req({ "x-client-ip": "203.0.113.5", "x-forwarded-for": "1.2.3.4, 203.0.113.5" }));
    expect(summary).toEqual({ clientIpHeader: true, entries: 2, forwardedFor: true });
    expect(JSON.stringify(summary)).not.toContain("203.0.113.5");
  });

  it("reports an absent header", () => {
    expect(forwardedSummary(req({}))).toEqual({ clientIpHeader: false, entries: 0, forwardedFor: false });
  });
});

describe("hashValue", () => {
  afterEach(() => {
    delete process.env.ACCESS_HASH_KEY;
  });

  it("is stable, 32 hex characters and never the input", () => {
    const a = hashValue("ip", "203.0.113.5");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(hashValue("ip", "203.0.113.5")).toBe(a);
    expect(a).not.toContain("203");
  });

  it("separates kinds and changes with the key", () => {
    const plain = hashValue("ip", "203.0.113.5");
    expect(hashValue("ua", "203.0.113.5")).not.toBe(plain);
    process.env.ACCESS_HASH_KEY = "rotate-me";
    expect(hashValue("ip", "203.0.113.5")).not.toBe(plain);
  });
});
