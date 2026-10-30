import { executeQuery } from "../db";
import { resolveRecipientRecord, type RecipientClaim } from "./recipientRecords";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));

const query = jest.mocked(executeQuery);
const conn = {} as never;
const claim = (over: Partial<RecipientClaim> = {}): RecipientClaim => ({ address: "pat@example.com", recipientRefId: "7", recipientType: "tenancy", ...over });

beforeEach(() => jest.clearAllMocks());

describe("a tenancy recipient is resolved from the tenancy, not from the request", () => {
  it("passes when the address is one of the tenancy's stored contacts and it is not a test record", async () => {
    query.mockResolvedValueOnce([{ Archived: 0, IsTest: 0, Matches: 1 }]);
    expect(await resolveRecipientRecord(conn, claim())).toEqual({ ok: true });
    const [, sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM dbo\.Tenants WHERE TenantId = @Id/);
    expect(params).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Id", value: 7 }), expect.objectContaining({ name: "Address", value: "pat@example.com" })]));
  });

  it("refuses an address that isn't the tenancy's contact, naming why", async () => {
    query.mockResolvedValueOnce([{ Archived: 0, IsTest: 0, Matches: 0 }]).mockResolvedValueOnce([]);
    expect(await resolveRecipientRecord(conn, claim())).toMatchObject({ code: "address_mismatch", ok: false });
  });

  it("passes an address that is one of the tenancy's listed contacts (TR2), read only from active ones", async () => {
    query.mockResolvedValueOnce([{ Archived: 0, IsTest: 0, Matches: 0 }]).mockResolvedValueOnce([{ Hit: 1 }]);
    expect(await resolveRecipientRecord(conn, claim())).toEqual({ ok: true });
    expect(query.mock.calls[1][1]).toMatch(/dbo\.TenancyContacts WHERE TenantId = @Id AND ArchivedAt IS NULL/);
  });

  it("still refuses a test tenancy whose listed contact matches", async () => {
    query.mockResolvedValueOnce([{ Archived: 0, IsTest: 1, Matches: 0 }]);
    expect(await resolveRecipientRecord(conn, claim())).toMatchObject({ code: "test_record", ok: false });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("refuses a test tenancy first, even when the address matches", async () => {
    query.mockResolvedValueOnce([{ Archived: 0, IsTest: 1, Matches: 1 }]);
    expect(await resolveRecipientRecord(conn, claim())).toMatchObject({ code: "test_record", ok: false });
  });

  it("refuses a tenancy that is missing or archived, and an id that isn't a number, without asking", async () => {
    query.mockResolvedValueOnce([]);
    expect(await resolveRecipientRecord(conn, claim())).toMatchObject({ code: "unknown_record", ok: false });
    query.mockResolvedValueOnce([{ Archived: 1, IsTest: 0, Matches: 1 }]);
    expect(await resolveRecipientRecord(conn, claim())).toMatchObject({ code: "unknown_record", ok: false });
    query.mockClear();
    for (const recipientRefId of [null, "abc", "0", "7; DROP TABLE x"]) {
      expect(await resolveRecipientRecord(conn, claim({ recipientRefId }))).toMatchObject({ code: "unknown_record", ok: false });
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe("a contractor or staff recipient must be the record's stored address", () => {
  it.each([["contractor", /FROM dbo\.Contractors WHERE ContractorID = @Id/], ["staff", /FROM dbo\.AppUsers WHERE UserID = @Id/]] as const)("%s", async (recipientType, sql) => {
    query.mockResolvedValueOnce([{ Matches: 1 }]);
    expect(await resolveRecipientRecord(conn, claim({ recipientType }))).toEqual({ ok: true });
    expect(query.mock.calls[0][1]).toMatch(sql);
    query.mockResolvedValueOnce([{ Matches: 0 }]);
    expect(await resolveRecipientRecord(conn, claim({ recipientType }))).toMatchObject({ code: "address_mismatch", ok: false });
    query.mockResolvedValueOnce([]);
    expect(await resolveRecipientRecord(conn, claim({ recipientType }))).toMatchObject({ code: "unknown_record", ok: false });
  });

  it("refuses a contractor or staff recipient with no usable id", async () => {
    expect(await resolveRecipientRecord(conn, claim({ recipientRefId: null, recipientType: "contractor" }))).toMatchObject({ code: "unknown_record", ok: false });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("a typed (manual) address", () => {
  it("is refused when it is any test tenancy's contact, whatever the request says it is", async () => {
    query.mockResolvedValueOnce([{ Hit: 1 }]);
    expect(await resolveRecipientRecord(conn, claim({ recipientRefId: null, recipientType: "manual" }))).toMatchObject({ code: "test_record", ok: false });
    expect(query.mock.calls[0][1]).toMatch(/IsTest = 1/);
  });

  it("goes when it is no test record's contact", async () => {
    query.mockResolvedValueOnce([]);
    expect(await resolveRecipientRecord(conn, claim({ recipientRefId: null, recipientType: "manual" }))).toEqual({ ok: true });
  });
});

describe("every statement is parameterised", () => {
  it("never puts the address or id in the SQL text", async () => {
    query.mockResolvedValue([{ Archived: 0, Hit: 0, IsTest: 0, Matches: 1 }]);
    for (const recipientType of ["tenancy", "contractor", "staff", "manual"] as const) {
      await resolveRecipientRecord(conn, claim({ address: "evil'--@x.co", recipientRefId: recipientType === "manual" ? null : "7", recipientType }));
    }
    for (const [, sql] of query.mock.calls) expect(sql).not.toMatch(/evil|--@|\b7\b/);
  });
});
