/// <reference types="jest" />
// UXB-08: a job whose quote is approved and which has no purchase order waits on a facilities manager. Directors, the
// CFO and accounts hold the capability but are not told it is theirs: it is a wait for them, not "do".

import { buildStepFacts } from "../jobStepFacts";
import { resolveJobStep } from "../jobStepResolver";
import { AUTHORITY, viewerOf, ROLES } from "../__tests__/fixtures/obligationsWorld";
import { jobsSource } from "./sources/jobs";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn(), timer: jest.fn() } }));

const base = {
  ApprovedQuoteID: 1, AssignedTo: "Fran Officer", AssignedToUserID: 2, AwaitingRole: "facilities", BuildingName: "Tower A", CreatedAt: new Date("2026-11-01T01:00:00Z"),
  ExpectedProgressUpdate: null, IsContract: false, IsInternal: false, JobID: 21, Status: "Work", StatusSince: new Date("2026-11-02T01:00:00Z"), Title: "Needs a PO",
};
const { nextAction, step } = resolveJobStep(
  buildStepFacts(base, { invoices: [], purchaseOrders: [], quotes: [{ Status: "approved" }], requested: [] } as never, AUTHORITY),
);
const rows = [{ ...base, NextAction: nextAction, Step: step }];

describe("raising the purchase order is on a facilities manager only (UXB-08)", () => {
  it("is the step", () => expect(step.key).toBe("raise_po"));

  it.each(ROLES.map((role) => [role]))("%s", (role) => {
    const items = jobsSource.derive(rows, viewerOf(role) as never, {} as never);
    const mine = items.find((item) => item.id === "job:21");
    expect({ role, doing: mine?.group === "do" }).toEqual({ doing: role === "facilities_manager", role });
  });
});
