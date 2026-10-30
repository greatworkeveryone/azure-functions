/// <reference types="jest" />
import { createHash } from "crypto";

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

import { resolveTenantLink } from "./resolve";
import { issueLink } from "./issue";
import { setEmailOnly } from "./revoke";
import { addMonths, expiryMonths, hashToken, isTokenShaped, linkUrl, newToken } from "./token";
import { linkStatus, versionBuffer } from "./store";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import type { MailSender } from "../comms/graphSend";

export {};
const db = require("../db") as { executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const conn = {} as never;
const NOW = new Date("2026-11-01T00:00:00Z");
const FUTURE = new Date("2027-06-01T00:00:00Z");
const ACTOR = { kind: "user", name: "Simone", role: "facilities_manager", userId: 7 } as const;
const VERSION = Buffer.from("0000000000000001", "hex");

type Handler = (sql: string, params: { name: string; value: unknown }[]) => unknown[] | undefined;
function fakeDb(handlers: Handler[]) {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string, params: { name: string; value: unknown }[] = []) => {
    for (const h of handlers) {
      const out = h(sql, params);
      if (out !== undefined) return out;
    }
    return [];
  });
}
const sqlCalls = () => db.executeQuery.mock.calls.map((c) => ({ params: (c[2] ?? []) as { name: string; value: unknown }[], sql: String(c[1]) }));

beforeEach(() => {
  db.executeQuery.mockReset();
  db.rollbackTransaction.mockClear();
  process.env.APP_BASE_URL = "https://floorplan.example.test";
  delete process.env.DEV_EMAIL_OVERRIDE;
});

describe("token", () => {
  it("is 256 bits of random, base64url, and only its SHA-256 identifies it", () => {
    const a = newToken();
    expect(isTokenShaped(a)).toBe(true);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(newToken()).not.toBe(a);
    expect(hashToken(a)).toEqual(createHash("sha256").update(a).digest());
    expect(hashToken(a)).toHaveLength(32);
  });
  it("builds /t#token on the app origin and refuses a missing or non-https origin", () => {
    expect(linkUrl("abc", "https://app.example.test/")).toBe("https://app.example.test/t#abc");
    expect(() => linkUrl("abc", "")).toThrow();
    expect(() => linkUrl("abc", "http://evil.example")).toThrow();
  });
  it("expires after 12 months unless configured, within 1 to 36", () => {
    expect(expiryMonths(undefined, {})).toBe(12);
    expect(expiryMonths(undefined, { TENANT_LINK_EXPIRY_MONTHS: "6" })).toBe(6);
    expect(expiryMonths(24, {})).toBe(24);
    expect(expiryMonths(0, {})).toBeNull();
    expect(expiryMonths(37, {})).toBeNull();
    expect(addMonths(new Date("2026-01-15T00:00:00Z"), 12).toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });
  it("reads a link's status and rejects a malformed version", () => {
    expect(linkStatus(null, NOW)).toBe("none");
    expect(linkStatus({ ExpiresAt: FUTURE, RevokedAt: null }, NOW)).toBe("active");
    expect(linkStatus({ ExpiresAt: new Date("2026-10-01"), RevokedAt: null }, NOW)).toBe("expired");
    expect(linkStatus({ ExpiresAt: FUTURE, RevokedAt: NOW }, NOW)).toBe("revoked");
    expect(versionBuffer("nope")).toBeNull();
    expect(versionBuffer(VERSION.toString("base64"))).toEqual(VERSION);
  });
});

describe("resolveTenantLink", () => {
  const token = newToken();
  const good = (over: Record<string, unknown> = {}) => ({
    ActivatedAt: new Date("2026-10-30"), BuildingId: 5, ContactArchivedAt: null, ContactId: 11, EmailOnly: false, ExpiresAt: FUTURE,
    LinkId: 3, RevokedAt: null, TenancyArchivedAt: null, TenantId: 9, TokenHash: hashToken(token), ...over,
  });
  const world = (row: Record<string, unknown> | null): Handler[] => [
    (sql) => (sql.includes("FROM dbo.TenantLinks l") ? (row ? [row] : []) : undefined),
    (sql) => (sql.includes("UPDATE dbo.TenantLinks SET LastUsedAt") ? [{ UseCount: 4 }] : undefined),
  ];

  it("returns the tenancy, contact and building, counts the use and ledgers it", async () => {
    fakeDb(world(good()));
    await expect(resolveTenantLink(token, { connection: conn, now: NOW })).resolves.toEqual({ buildingId: 5, contactId: 11, tenantId: 9 });
    const [entry] = ledgerInserts(db.executeQuery);
    expect(entry).toMatchObject({ action: "tenancy.link_use", actorKind: "system", subjectId: "9", subjectType: "tenancy" });
    expect(entry.after).toEqual({ contactId: 11, linkId: 3, useCount: 4 });
  });

  it("looks the token up by its hash only: the token itself is never sent to the database", async () => {
    fakeDb(world(good()));
    await resolveTenantLink(token, { connection: conn, now: NOW });
    const lookup = sqlCalls().find((c) => c.sql.includes("FROM dbo.TenantLinks l"));
    expect(lookup?.params[0].value).toEqual(hashToken(token));
    expect(JSON.stringify(sqlCalls())).not.toContain(token);
  });

  it.each([
    ["unknown", null],
    ["not delivered", good({ ActivatedAt: null })],
    ["revoked", good({ RevokedAt: new Date("2026-10-31") })],
    ["expired", good({ ExpiresAt: new Date("2026-10-31") })],
    ["archived contact", good({ ContactArchivedAt: new Date("2026-10-31") })],
    ["email-only tenancy", good({ EmailOnly: true })],
    ["archived tenancy", good({ TenancyArchivedAt: new Date("2026-10-31") })],
    ["hash mismatch", good({ TokenHash: hashToken(newToken()) })],
  ])("is null for a %s link, and counts no use", async (_name, row) => {
    fakeDb(world(row));
    await expect(resolveTenantLink(token, { connection: conn, now: NOW })).resolves.toBeNull();
    expect(ledgerInserts(db.executeQuery)).toEqual([]);
    expect(sqlCalls().some((c) => c.sql.includes("UPDATE dbo.TenantLinks"))).toBe(false);
  });

  it("is null for something that is not shaped like a token, without touching the database", async () => {
    fakeDb([]);
    await expect(resolveTenantLink("short", { connection: conn })).resolves.toBeNull();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("is null when the link was revoked between the lookup and the use", async () => {
    fakeDb([(sql) => (sql.includes("FROM dbo.TenantLinks l") ? [good()] : undefined), (sql) => (sql.includes("UPDATE dbo.TenantLinks SET LastUsedAt") ? [] : undefined)]);
    await expect(resolveTenantLink(token, { connection: conn, now: NOW })).resolves.toBeNull();
    expect(ledgerInserts(db.executeQuery)).toEqual([]);
  });
});

describe("issueLink", () => {
  const tenancyRow = { ArchivedAt: null, BuildingId: 5, EmailOnly: false, IsTest: false, LegalName: "Acme", RowVersion: VERSION, TenantId: 9 };
  const contactRow = { ArchivedAt: null, ArchivedBy: null, AuthorisedForCosts: false, ContactId: 11, Email: "pat@acme.test", IsEscalation: false, Name: "Pat", Phone: null, ReportsIssues: true, RowVersion: VERSION, TenantId: 9 };
  const base: Handler[] = [
    (sql) => (sql.includes("FROM dbo.Tenants WITH (UPDLOCK") ? [tenancyRow] : undefined),
    (sql) => (sql.includes("FROM dbo.TenancyContacts c") && sql.includes("WITH (UPDLOCK") ? [contactRow] : undefined),
    (sql) => (sql.includes("FROM dbo.TenancyContacts c") ? [contactRow] : undefined),
    (sql) => (sql.includes("SELECT IsTest") ? [{ Archived: 0, IsTest: false, Matches: 1 }] : undefined),
    (sql) => (sql.includes("INSERT INTO dbo.TenantLinks") ? [{ LinkId: 42 }] : undefined),
  ];
  const input = { actor: ACTOR, contactId: 11, months: 12, reissue: false, tenantId: 9 } as const;
  const okSender = () => {
    const sent: string[] = [];
    const sender: MailSender = {
      createDraft: jest.fn(async (d) => { sent.push(d.html); return { graphMessageId: "g1", internetMessageId: null }; }),
      sendDraft: jest.fn().mockResolvedValue(undefined),
    };
    return { sender, sent };
  };

  it("refuses, and issues nothing, while sending is switched off", async () => {
    fakeDb(base);
    const r = await issueLink(conn, input, { mode: "off", now: () => NOW });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("stores only the hash of the token that the email carries, then makes it usable and ledgers it", async () => {
    fakeDb(base);
    const { sender, sent } = okSender();
    const r = await issueLink(conn, input, { mode: "live", now: () => NOW, sender });
    expect(r).toMatchObject({ delivery: "sent", linkId: 42, ok: true });
    const token = /floorplan\.example\.test\/t#([A-Za-z0-9_-]{43})/.exec(sent[0])?.[1];
    expect(token).toBeDefined();
    const insert = sqlCalls().find((c) => c.sql.includes("INSERT INTO dbo.TenantLinks"));
    expect(insert?.params.find((p) => p.name === "Hash")?.value).toEqual(hashToken(token as string));
    expect(JSON.stringify(sqlCalls())).not.toContain(token as string);
    expect(sqlCalls().some((c) => c.sql.includes("SET ActivatedAt"))).toBe(true);
    const [entry] = ledgerInserts(db.executeQuery);
    expect(entry).toMatchObject({ action: "tenancy.link_issue", subjectId: "9" });
    expect(JSON.stringify(entry.after)).not.toContain(token as string);
    expect(JSON.stringify(entry.after)).not.toContain("pat@acme.test");
  });

  it("dry run composes but sends nothing and leaves no usable link", async () => {
    fakeDb(base);
    const { sender } = okSender();
    const r = await issueLink(conn, input, { mode: "dry-run", now: () => NOW, sender });
    expect(r).toEqual({ delivery: "dry_run", ok: true });
    expect(sender.createDraft).not.toHaveBeenCalled();
    expect(sqlCalls().some((c) => c.sql.includes("SET ActivatedAt"))).toBe(false);
    expect(sqlCalls().some((c) => c.sql.includes("SET RevokedAt") && c.params.some((p) => p.value === "dry_run"))).toBe(true);
  });

  it("revokes the new link and keeps the old one when the send fails", async () => {
    fakeDb([(sql) => (sql.includes("FROM dbo.TenantLinks WITH (UPDLOCK") ? [{ ExpiresAt: FUTURE, LinkId: 1 }] : undefined), ...base]);
    const sender: MailSender = { createDraft: jest.fn().mockRejectedValue(new Error("boom")), sendDraft: jest.fn() };
    const r = await issueLink(conn, { ...input, reissue: true }, { mode: "live", now: () => NOW, sender });
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(sqlCalls().some((c) => c.sql.includes("SET ActivatedAt"))).toBe(false);
    expect(sqlCalls().some((c) => c.sql.includes("SET RevokedAt") && c.params.some((p) => p.value === "send_failed"))).toBe(true);
    expect(sqlCalls().some((c) => c.params.some((p) => p.value === "reissued"))).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toEqual([]);
  });

  it("is never issued to an email-only tenancy", async () => {
    fakeDb([(sql) => (sql.includes("FROM dbo.Tenants WITH (UPDLOCK") ? [{ ...tenancyRow, EmailOnly: true }] : undefined), ...base]);
    const { sender } = okSender();
    const r = await issueLink(conn, input, { mode: "live", now: () => NOW, sender });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(sqlCalls().some((c) => c.sql.includes("INSERT INTO dbo.TenantLinks"))).toBe(false);
    expect(sender.createDraft).not.toHaveBeenCalled();
  });

  it("is refused for a test tenancy (the egress guard) and for an address that is not the contact's", async () => {
    fakeDb([(sql) => (sql.includes("SELECT IsTest") ? [{ Archived: 0, IsTest: true, Matches: 1 }] : undefined), ...base]);
    expect(await issueLink(conn, input, { mode: "live", now: () => NOW, sender: okSender().sender })).toMatchObject({ ok: false, status: 409 });
    expect(sqlCalls().some((c) => c.sql.includes("INSERT INTO dbo.TenantLinks"))).toBe(false);
  });

  it("rewrites the recipient through DEV_EMAIL_OVERRIDE", async () => {
    process.env.DEV_EMAIL_OVERRIDE = "dev@rp.test";
    fakeDb(base);
    const { sender } = okSender();
    await issueLink(conn, input, { mode: "live", now: () => NOW, sender });
    expect((sender.createDraft as jest.Mock).mock.calls[0][0]).toMatchObject({ subject: expect.stringContaining("[For pat@acme.test]"), to: "dev@rp.test" });
  });
});

describe("a stale write is a 409", () => {
  it("email only: a stale tenancy version changes nothing and is refused with 409", async () => {
    fakeDb([(sql) => (sql.includes("FROM dbo.Tenants WITH (UPDLOCK") ? [{ ArchivedAt: null, BuildingId: 5, EmailOnly: false, IsTest: false, LegalName: "Acme", RowVersion: VERSION, TenantId: 9 }] : undefined), (sql) => (sql.includes("UPDATE dbo.Tenants SET EmailOnly") ? [] : undefined)]);
    const r = await setEmailOnly(conn, { actor: ACTOR, emailOnly: true, rowVersion: VERSION.toString("base64"), tenantId: 9 });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(ledgerInserts(db.executeQuery)).toEqual([]);
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });

  it("email only: turning it on revokes every working link and ledgers that", async () => {
    fakeDb([
      (sql) => (sql.includes("FROM dbo.Tenants WITH (UPDLOCK") ? [{ ArchivedAt: null, BuildingId: 5, EmailOnly: false, IsTest: false, LegalName: "Acme", RowVersion: VERSION, TenantId: 9 }] : undefined),
      (sql) => (sql.includes("UPDATE dbo.Tenants SET EmailOnly") ? [{ TenantId: 9 }] : undefined),
      (sql) => (sql.includes("WHERE TenantId = @TenantId AND ActivatedAt IS NOT NULL") ? [{ ContactId: 11, LinkId: 3 }] : undefined),
      (sql) => (sql.includes("SET RevokedAt") ? [{ LinkId: 3 }] : undefined),
    ]);
    const r = await setEmailOnly(conn, { actor: ACTOR, emailOnly: true, rowVersion: VERSION.toString("base64"), tenantId: 9 });
    expect(r).toEqual({ ok: true, revoked: 1 });
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "tenancy.email_only_set" });
  });
});
