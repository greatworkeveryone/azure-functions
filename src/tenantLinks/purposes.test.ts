/// <reference types="jest" />
import { AppRole, rolesPassGate } from "../auth";
import { ANY_PURPOSE_ISSUER_ROLES, contactMayAct, isLinkPurpose, LINK_PURPOSES, mayIssuePurpose, purposeOpens, PURPOSE_POLICY } from "./purposes";
import { ISSUE_TENANT_LINKS_ROLES } from "./roles";

describe("tenant link purposes", () => {
  it("has one live purpose, requests, with plain-English words", () => {
    expect(LINK_PURPOSES).toEqual(["requests"]);
    expect(PURPOSE_POLICY.requests.label).toBe("Report and track maintenance requests");
    expect(PURPOSE_POLICY.requests.forText).toBe("reporting and tracking maintenance requests");
  });

  it("lets every staff role issue a requests link, and nobody without a role", () => {
    for (const role of [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.CFO, AppRole.DIRECTOR, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL]) {
      expect(mayIssuePurpose("requests", [role])).toBe(true);
      expect(rolesPassGate([role], ISSUE_TENANT_LINKS_ROLES)).toBe(true);
    }
    expect(mayIssuePurpose("requests", [])).toBe(false);
    expect(mayIssuePurpose("requests", [AppRole.USER])).toBe(false);
    expect(ANY_PURPOSE_ISSUER_ROLES).toEqual(PURPOSE_POLICY.requests.issuerRoles);
  });

  it("opens only the requests section, and only for a known purpose", () => {
    expect(purposeOpens("requests", "requests")).toBe(true);
    expect(purposeOpens("costs", "requests")).toBe(false);
    expect(isLinkPurpose("costs")).toBe(false);
    expect(isLinkPurpose("constructor")).toBe(false);
  });

  it("gives action only to a contact who reports issues; the rest see a view-only page", () => {
    expect(contactMayAct("requests", { reportsIssues: true })).toBe(true);
    expect(contactMayAct("requests", { reportsIssues: false })).toBe(false);
  });
});
