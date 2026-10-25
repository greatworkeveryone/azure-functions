import { AppRole } from "../auth";
import { isOrgAddress, mayUseIdentity, resolveReplyTo, type CommsIdentity } from "./identity";

const identity = (over: Partial<CommsIdentity> = {}): CommsIdentity => ({
  address: "accounts@randazzo.properties",
  allowedRoles: [AppRole.ACCOUNTS],
  archivedAt: null,
  displayName: "Randazzo Accounts",
  identityId: 4,
  isActive: true,
  signature: { email: "accounts@randazzo.properties", lines: ["Accounts team"], phone: null },
  teamLabel: "Accounts",
  ...over,
});
const actor = (roles: string[], email = "fay@randazzo.properties") => ({ email, name: "Fay Facilities", roles });

describe("isOrgAddress", () => {
  it.each(["fay@randazzo.properties", "Fay.Smith@Randazzo.Properties", " fay@randazzo.properties "])("accepts %s", (address) => {
    expect(isOrgAddress(address)).toBe(true);
  });
  it.each([
    "fay@gmail.com",
    "fay@randazzo.properties.evil.com",
    "fay@evilrandazzo.properties",
    "fay@sub.randazzo.properties",
    "a@b@randazzo.properties",
    "@randazzo.properties",
    "randazzo.properties",
    "fay, boss@randazzo.properties",
    "<fay@randazzo.properties>",
  ])("refuses %s", (address) => {
    expect(isOrgAddress(address)).toBe(false);
  });
});

describe("mayUseIdentity: the roles an identity names", () => {
  it.each([
    [[AppRole.ACCOUNTS], true],
    [[AppRole.ACCOUNTS_APPROVAL], true],
    [[AppRole.CFO], true],
    [[AppRole.DIRECTOR], true],
    [[AppRole.FACILITIES], false],
    [[AppRole.FACILITIES_APPROVAL], false],
    [[AppRole.USER], false],
    [[AppRole.ADMIN], false],
    [[], false],
  ])("%j -> %s for an accounts identity", (roles, expected) => {
    expect(mayUseIdentity(roles, identity())).toBe(expected);
  });

  it("lets admin through only when it is a named role, and an identity can't name it through the form", () => {
    expect(mayUseIdentity([AppRole.ADMIN], identity({ allowedRoles: [AppRole.ADMIN] }))).toBe(false);
  });

  it("counts a manager as the team they manage", () => {
    expect(mayUseIdentity([AppRole.FACILITIES_APPROVAL], identity({ allowedRoles: [AppRole.FACILITIES] }))).toBe(true);
  });
});

describe("resolveReplyTo", () => {
  it("resolves an active identity the role may use", () => {
    const result = resolveReplyTo(actor([AppRole.ACCOUNTS]), { identityId: 4, kind: "identity" }, identity());
    expect(result).toEqual({ ok: true, value: { address: "accounts@randazzo.properties", identity: identity(), name: "Randazzo Accounts" } });
  });

  it("refuses an identity the role may not use", () => {
    const result = resolveReplyTo(actor([AppRole.FACILITIES]), { identityId: 4, kind: "identity" }, identity());
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses an inactive or archived identity", () => {
    expect(resolveReplyTo(actor([AppRole.ACCOUNTS]), { identityId: 4, kind: "identity" }, identity({ isActive: false }))).toMatchObject({ ok: false, status: 403 });
    expect(resolveReplyTo(actor([AppRole.ACCOUNTS]), { identityId: 4, kind: "identity" }, identity({ archivedAt: "2026-10-01T00:00:00.000Z" }))).toMatchObject({ ok: false, status: 403 });
  });

  it("says an identity that does not exist, or is not the one asked for, isn't available", () => {
    expect(resolveReplyTo(actor([AppRole.ACCOUNTS]), { identityId: 9, kind: "identity" }, null)).toMatchObject({ ok: false, status: 404 });
    expect(resolveReplyTo(actor([AppRole.ACCOUNTS]), { identityId: 9, kind: "identity" }, identity())).toMatchObject({ ok: false, status: 404 });
  });

  it("allows the sender's own company address, lower-cased, with their name", () => {
    const result = resolveReplyTo(actor([AppRole.FACILITIES], "Fay@Randazzo.Properties"), { kind: "own" }, null);
    expect(result).toEqual({ ok: true, value: { address: "fay@randazzo.properties", identity: null, name: "Fay Facilities" } });
  });

  it("refuses an own address that is not on the company domain", () => {
    expect(resolveReplyTo(actor([AppRole.FACILITIES], "fay@gmail.com"), { kind: "own" }, null)).toMatchObject({ ok: false, status: 403 });
  });
});
