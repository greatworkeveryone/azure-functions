/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contractorContactAdapter } from "./contractorContact";
import { APPROVAL_POLICIES, DECISION_ONLY_POLICIES } from "../approvals/policies";
import { NOT_A_RECORD } from "../../test-data";
import { getAdapter } from "./registry";
import "./index";

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
const db = jest.requireMock("../../db") as { executeQuery: jest.Mock };
const conn = {} as never;
const ref = { policyKey: "contractor.contact_changed", subjectId: "7", subjectType: "contractor" };

describe("contractor contact adapter", () => {
  it("is registered, and ends only by a second person's decision", () => {
    expect(getAdapter("contractor")).toBe(contractorContactAdapter);
    expect(DECISION_ONLY_POLICIES.has(APPROVAL_POLICIES.contractorContact)).toBe(true);
    expect(contractorContactAdapter.withdrawable?.({ kind: "authority", policyKey: ref.policyKey })).toBe(false);
  });

  it("is live while a change is unconfirmed, and not once confirmed", async () => {
    db.executeQuery.mockResolvedValueOnce([{ ContactChangedAt: new Date(), ContactConfirmedAt: null }]);
    expect(await contractorContactAdapter.isConditionActive(conn, ref, new Date())).toBe(true);
    db.executeQuery.mockResolvedValueOnce([{ ContactChangedAt: new Date(), ContactConfirmedAt: new Date() }]);
    expect(await contractorContactAdapter.isConditionActive(conn, ref, new Date())).toBe(false);
  });

  it("names the contractor and who changed it", async () => {
    db.executeQuery.mockResolvedValueOnce([{ ContactChangedBy: "Sam Lee", ContractorID: 7, ContractorName: "Arjays" }]);
    expect((await contractorContactAdapter.loadSummary(conn, "7"))?.summary).toBe("Contractor · Arjays · email or ABN changed by Sam Lee");
    expect(await contractorContactAdapter.loadSummary(conn, "x; DROP")).toBeNull();
  });
});

describe("migration 198", () => {
  const sql = readFileSync(join(__dirname, "../../../migrations/198_contractor_contact_policy.sql"), "utf8");
  it("seeds the policy active, insert-only, with the same columns as 199", () => {
    expect(sql).toContain("(N'contractor.contact_changed', N'authority', 0, N'business', N'yes'");
    expect(sql).toMatch(/\]', 1\)\s*\) AS v/);
    expect(sql).toMatch(/WHEN NOT MATCHED BY TARGET THEN\s+INSERT/);
    expect(sql).not.toMatch(/WHEN MATCHED/i);
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i);
  });
});

describe("staging sends nothing", () => {
  it("the Graph sender returns a synthetic id and never calls the network on Staging", async () => {
    const saved = process.env.AZURE_FUNCTIONS_ENVIRONMENT;
    process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Staging";
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    try {
      const { graphSendMail } = await import("../../graph");
      await graphSendMail(NOT_A_RECORD, "a@b.test", "Contractor changed", "body");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (saved === undefined) delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
      else process.env.AZURE_FUNCTIONS_ENVIRONMENT = saved;
    }
  });
});
