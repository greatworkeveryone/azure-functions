/// <reference types="jest" />
// J4: the "Review quote" Planner task (a job at Awaiting Approval, facilities)
// goes to people who can approve a quote, from J1's eligible roles
// (SUBJECT_ELIGIBLE_ROLES.quote; admin acts on test records only). A job
// assigned to a field officer, who adds quotes but approves none (decision 1),
// sends the task to the approvers in the Facilities group instead.
import type { Connection } from "tedious";

export {};

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createServiceConnection: jest.fn(), executeQuery: jest.fn() }));
jest.mock("../planner", () => ({
  getPlanConfig: jest.fn().mockReturnValue({ bucketId: "bucket", planId: "plan" }),
  graphCompletePlannerTask: jest.fn().mockResolvedValue(undefined),
  graphCreatePlannerTask: jest.fn().mockResolvedValue("task-1"),
  graphGetGroupMembers: jest.fn().mockResolvedValue([]),
  graphGetPlannerTask: jest.fn().mockResolvedValue({ etag: "etag" }),
}));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), flush: jest.fn().mockResolvedValue(true) } }));

const db = require("../db") as { executeQuery: jest.Mock };
const planner = require("../planner") as { graphCreatePlannerTask: jest.Mock };
const { syncJobAwaitingFacilitiesApproval } = require("../jobPlannerSync") as typeof import("../jobPlannerSync");

const connection = {} as Connection;
const deps = { appBaseUrl: "https://floorplan.example", connection, facilitiesMembers: ["fran-oid", "fiona-oid", "maddie-oid"] };
const PEOPLE = [
  { EntraOid: "fran-oid", Role: "facilities" },
  { EntraOid: "fiona-oid", Role: "facilities" },
  { EntraOid: "maddie-oid", Role: "facilities_manager" },
];
const job = (over: Record<string, unknown> = {}) => ({
  AssignedToEntraOid: null,
  AssignedToRole: null,
  AwaitingRole: "facilities",
  BuildingName: "9 Cavanagh",
  IsArchived: 0,
  JobID: 7,
  Kind: "facilities",
  Status: "Awaiting Approval",
  Title: "Leaking roof",
  ...over,
});
function routes(jobRow: Record<string, unknown>, people = PEOPLE): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
    /FROM dbo\.Jobs j/.test(sql) ? [jobRow] : /FROM dbo\.AppUsers/.test(sql) ? people : [],
  );
}
const assignees = (): string[] => (planner.graphCreatePlannerTask.mock.calls[0][0] as { assigneeIds: string[] }).assigneeIds;

let saved: string | undefined;
beforeEach(() => {
  jest.clearAllMocks();
  saved = process.env.PLANNER_SYNC_ENABLED;
  process.env.PLANNER_SYNC_ENABLED = "true";
});
afterEach(() => {
  if (saved === undefined) delete process.env.PLANNER_SYNC_ENABLED;
  else process.env.PLANNER_SYNC_ENABLED = saved;
});

describe("the Review quote task goes to someone who can approve the quote", () => {
  it("an assignee who can approve gets it", async () => {
    routes(job({ AssignedToEntraOid: "maddie-oid", AssignedToRole: "facilities_manager" }));
    await syncJobAwaitingFacilitiesApproval(7, deps);
    expect(assignees()).toEqual(["maddie-oid"]);
  });

  it("an assignee who is a field officer doesn't: the approvers in the group do", async () => {
    routes(job({ AssignedToEntraOid: "fran-oid", AssignedToRole: "facilities" }));
    await syncJobAwaitingFacilitiesApproval(7, deps);
    expect(assignees()).toEqual(["maddie-oid"]);
  });

  it("with nobody assigned, the approvers in the group", async () => {
    routes(job());
    await syncJobAwaitingFacilitiesApproval(7, deps);
    expect(assignees()).toEqual(["maddie-oid"]);
  });

  it("an admin assignee isn't an approver either (decision 4)", async () => {
    routes(job({ AssignedToEntraOid: "ada-oid", AssignedToRole: "admin" }));
    await syncJobAwaitingFacilitiesApproval(7, deps);
    expect(assignees()).toEqual(["maddie-oid"]);
  });

  it("falls back to the whole group when it holds no approver, so the task still lands", async () => {
    routes(job(), PEOPLE.slice(0, 2));
    await syncJobAwaitingFacilitiesApproval(7, deps);
    expect(assignees()).toEqual(["fran-oid", "fiona-oid", "maddie-oid"]);
  });

  it("reads the assignee's role with the job", async () => {
    routes(job());
    await syncJobAwaitingFacilitiesApproval(7, deps);
    const read = db.executeQuery.mock.calls.find((c: unknown[]) => /FROM dbo\.Jobs j/.test(String(c[1])))![1] as string;
    expect(read).toMatch(/au\.Role AS AssignedToRole/);
  });
});
