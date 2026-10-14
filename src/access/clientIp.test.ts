import { isAllowedNetwork, moneyGateConfig } from "../moneyGate";
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

  it("refuses a header with no public address", () => {
    expect(clientAddress(req({ "x-forwarded-for": "127.0.0.1" }))).toBeNull();
    expect(clientAddress(req({ "x-forwarded-for": "10.1.2.3, 192.168.1.1" }))).toBeNull();
  });

  it("refuses at the first unreadable entry from the right instead of walking past it", () => {
    // The two fail-open cases from review-s2: the platform's own entry is
    // unreadable, so the forged office address to its left must not be used.
    expect(clientAddress(req({ "x-forwarded-for": "203.0.113.10, 2001:8003:1234:5678::1:51234" }))).toBeNull();
    expect(clientAddress(req({ "x-forwarded-for": "203.0.113.10, unknown" }))).toBeNull();
  });

  it("is null without the header", () => {
    expect(clientAddress(req({}))).toBeNull();
  });
});

describe("forwardedSummary", () => {
  it("reports presence and shape, never the address", () => {
    const summary = forwardedSummary(req({ "x-client-ip": "203.0.113.5", "x-forwarded-for": "1.2.3.4, 203.0.113.5, unknown" }));
    expect(summary).toEqual({ clientIpHeader: true, entries: 2, forwardedFor: true, unreadable: 1 });
    expect(JSON.stringify(summary)).not.toContain("203.0.113.5");
  });

  it("reports an absent header", () => {
    expect(forwardedSummary(req({}))).toEqual({ clientIpHeader: false, entries: 0, forwardedFor: false, unreadable: 0 });
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

// The reviewer's attack scripts (review-s2/attack/attack.cjs and attack2.cjs),
// run through the real clientAddress and the gate's network check. `address`
// is what clientAddress returns; `allowed` is the gate's verdict.
describe("review-s2 attack cases", () => {
  const OFFICE = "203.0.113.10";
  const ATTACKER = "192.0.2.66";
  const wide = moneyGateConfig({ MONEY_ALLOWED_CIDRS: "203.0.113.10, 198.51.100.0/24 2001:db8:abcd::/48" });
  const narrow = moneyGateConfig({ MONEY_ALLOWED_CIDRS: "203.0.113.10/32" });

  const ATTACK: [string, string | null, string | null, boolean][] = [
    // name, X-Forwarded-For, expected address, allowed
    ["attacker, office (platform appended the office)", `${ATTACKER}, ${OFFICE}`, OFFICE, true],
    ["office, attacker (forged office on the left)", `${OFFICE}, ${ATTACKER}`, ATTACKER, false],
    ["office, attacker:port", `${OFFICE}, ${ATTACKER}:1234`, ATTACKER, false],
    ["office, private hop", `${OFFICE}, 10.0.0.5`, OFFICE, true],
    ["attacker, office, private hop", `${ATTACKER}, ${OFFICE}, 10.0.0.5`, OFFICE, true],
    ["single private 10.1.2.3", "10.1.2.3", null, false],
    ["single private 192.168.1.1", "192.168.1.1", null, false],
    ["office only", OFFICE, OFFICE, true],
    ["office with port", `${OFFICE}:51515`, OFFICE, true],
    ["IPv6 office", "2001:db8:abcd::1", "2001:db8:abcd::1", true],
    ["IPv6 bracketed with port", "[2001:db8:abcd::1]:443", "2001:db8:abcd::1", true],
    ["IPv4-mapped office", `::ffff:${OFFICE}`, OFFICE, true],
    ["IPv4-mapped office in hex", "::ffff:cb00:710a", "::ffff:cb00:710a", true],
    ["spaces around entries", `  ${OFFICE}  ,   ${ATTACKER}  `, ATTACKER, false],
    ["office, garbage", `${OFFICE}, notanip`, null, false],
    ["garbage only", "notanip", null, false],
    ["office, empty slot", `${OFFICE},`, null, false],
    ["quoted office", `"${OFFICE}"`, OFFICE, true],
    ["leading zeros 203.000.113.010", "203.000.113.010", null, false],
    ["leading zeros 203.0.113.010", "203.0.113.010", null, false],
    ["no header", null, null, false],
    ["empty header", "", null, false],
    ["attacker, unknown", `${ATTACKER}, unknown`, null, false],
    ["office, ::1", `${OFFICE}, ::1`, OFFICE, true],
    ["office, link-local with zone id", `${OFFICE}, fe80::1%eth0`, null, false],
    ["office, CGNAT hop", `${OFFICE}, 100.64.0.1`, OFFICE, true],
    ["office, Azure link-local hop", `${OFFICE}, 169.254.130.1`, OFFICE, true],
    ["office, Azure wireserver (public) hop", `${OFFICE}, 168.63.129.16`, "168.63.129.16", false],
    ["attacker,office without a space", `${ATTACKER},${OFFICE}`, OFFICE, true],
    ["IPv6 office with zone id", "2001:db8:abcd::1%1", null, false],
    ["inside the /24", "198.51.100.255", "198.51.100.255", true],
    ["outside the /24", "198.51.101.0", "198.51.101.0", false],
    ["office, 6to4 attacker", `${OFFICE}, 2002:c000:242::1`, "2002:c000:242::1", false],
    ["office, NAT64 attacker", `${OFFICE}, 64:ff9b::c000:242`, "64:ff9b::c000:242", false],
    ["attacker, IPv4-mapped private hop", `${ATTACKER}, ::ffff:10.0.0.1`, ATTACKER, false],
    ["office, IPv4-mapped private hop", `${OFFICE}, ::ffff:10.0.0.1`, OFFICE, true],
  ];

  it.each(ATTACK)("%s", (_name, xff, address, allowed) => {
    const got = clientAddress(req(xff === null ? {} : { "x-forwarded-for": xff }));
    expect(got).toBe(address);
    expect(isAllowedNetwork(got, wide)).toBe(allowed);
  });

  const FORGED_OFFICE: [string, string][] = [
    ["platform IPv6 with an unbracketed port", "203.0.113.10, 2001:8003:1234:5678::1:51234"],
    ["platform IPv6 bracketed with a port", "203.0.113.10, [2001:8003:1234:5678::1]:51234"],
    ["platform 'unknown'", "203.0.113.10, unknown"],
    ["platform IPv4 with an odd port", "203.0.113.10, 192.0.2.66:port"],
    ["platform obfuscated RFC 7239 name", "203.0.113.10, _hidden"],
    ["empty platform entry", "203.0.113.10, "],
  ];

  it.each(FORGED_OFFICE)("a forged office address never passes: %s", (_name, xff) => {
    expect(isAllowedNetwork(clientAddress(req({ "x-forwarded-for": xff })), narrow)).toBe(false);
  });
});
