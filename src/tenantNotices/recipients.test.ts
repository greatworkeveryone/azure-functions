import type { Connection } from "tedious";
import { executeQuery } from "../db";
import { chooseStatusContacts, resolveStatusContacts, type NoticeContact } from "./recipients";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const query = jest.mocked(executeQuery);
const c = (id: number, email: string, over: Partial<NoticeContact> = {}): NoticeContact => ({ authorisedForCosts: false, contactId: id, email, name: `C${id}`, reportsIssues: false, ...over });
const row = (x: NoticeContact) => ({ AuthorisedForCosts: x.authorisedForCosts, ContactId: x.contactId, Email: x.email, Name: x.name, ReportsIssues: x.reportsIssues });

describe("chooseStatusContacts", () => {
  const reporter = c(1, "Pat@Tenant.example");
  const reportsIssues = c(2, "ops@tenant.example", { reportsIssues: true });
  const costs = c(3, "cfo@tenant.example", { authorisedForCosts: true });

  it("prefers the contact matching the request's own email, whatever the case", () => {
    expect(chooseStatusContacts([reporter, reportsIssues, costs], " pat@tenant.example ").map((x) => x.contactId)).toEqual([1]);
  });

  it("falls back to the contacts who report issues when the reporter isn't listed", () => {
    expect(chooseStatusContacts([reporter, reportsIssues, costs], "stranger@elsewhere.example").map((x) => x.contactId)).toEqual([2]);
    expect(chooseStatusContacts([reportsIssues, costs], null).map((x) => x.contactId)).toEqual([2]);
  });

  it("is empty when nobody reports issues, and lists a shared address once", () => {
    expect(chooseStatusContacts([costs], null)).toEqual([]);
    expect(chooseStatusContacts([c(4, "a@x.example", { reportsIssues: true }), c(5, "A@x.example", { reportsIssues: true })], null)).toHaveLength(1);
  });
});

describe("loading", () => {
  const conn = {} as Connection;

  it("reads only active contacts of an active tenancy that have an email", async () => {
    query.mockResolvedValueOnce([row(c(1, "pat@tenant.example", { reportsIssues: true }))]);
    expect((await resolveStatusContacts(conn, 9, null)).map((x) => x.contactId)).toEqual([1]);
    expect(String(query.mock.calls[0][1])).toMatch(/c\.ArchivedAt IS NULL AND t\.ArchivedAt IS NULL AND NULLIF\(LTRIM\(RTRIM\(c\.Email\)\)/);
  });
});
