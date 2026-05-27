import { describe, expect, it, jest, beforeEach } from "@jest/globals";

jest.mock("../db");
jest.mock("../planner");

import { executeQuery } from "../db";
import {
  getPlanConfig,
  graphCompletePlannerTask,
  graphCreatePlannerTask,
  graphGetPlannerTask,
} from "../planner";
import { syncKeyLostReported } from "../keyPlannerSync";

const mockExecuteQuery = executeQuery as jest.MockedFunction<typeof executeQuery>;
const mockGetPlanConfig = getPlanConfig as jest.MockedFunction<typeof getPlanConfig>;
const mockGraphCreate = graphCreatePlannerTask as jest.MockedFunction<typeof graphCreatePlannerTask>;
const mockGraphGet = graphGetPlannerTask as jest.MockedFunction<typeof graphGetPlannerTask>;
const mockGraphComplete = graphCompletePlannerTask as jest.MockedFunction<typeof graphCompletePlannerTask>;

const fakeConn = {} as any;
const baseDeps = {
  connection: fakeConn,
  facilitiesMembers: ["user-1", "user-2"],
  appBaseUrl: "https://test.local",
};

beforeEach(() => {
  jest.resetAllMocks();
  mockGetPlanConfig.mockReturnValue({ planId: "plan-1", bucketId: "bucket-1" });
});

describe("syncKeyLostReported", () => {
  it("creates a planner task when the key is lost and no row exists", async () => {
    mockExecuteQuery
      // SELECT key row (status = 'lost')
      .mockResolvedValueOnce([{
        Id: 42,
        KeyNumber: "K-12",
        BuildingName: "9 Cavanagh",
        Status: "lost",
        IsDeleted: false,
        LostAt: new Date("2026-05-20T00:00:00Z"),
        LostByName: "Jane Smith",
        LostComment: "Dropped on site",
        TenancyName: "Acme Corp",
      }])
      // SELECT PlannerTasks (no existing row)
      .mockResolvedValueOnce([])
      // INSERT
      .mockResolvedValueOnce([]);
    mockGraphCreate.mockResolvedValue("graph-task-abc");

    await syncKeyLostReported(42, baseDeps);

    expect(mockGraphCreate).toHaveBeenCalledWith(expect.objectContaining({
      planId: "plan-1",
      bucketId: "bucket-1",
      title: "Lost key — K-12 at 9 Cavanagh",
      assigneeIds: ["user-1", "user-2"],
    }));
    const insertCall = mockExecuteQuery.mock.calls.find((c) => /INSERT INTO dbo.PlannerTasks/i.test(c[1] as string));
    expect(insertCall).toBeDefined();
  });

  it("resolves the task when the key is no longer lost (e.g. restored)", async () => {
    mockExecuteQuery
      .mockResolvedValueOnce([{
        Id: 42,
        KeyNumber: "K-12",
        BuildingName: "9 Cavanagh",
        Status: "active",
        IsDeleted: false,
        LostAt: null,
        LostByName: null,
        LostComment: null,
        TenancyName: null,
      }])
      .mockResolvedValueOnce([{ Id: 99, PlannerTaskId: "graph-task-abc", Status: "active" }])
      .mockResolvedValueOnce([]);
    mockGraphGet.mockResolvedValue({ etag: "etag-1" });

    await syncKeyLostReported(42, baseDeps);

    expect(mockGraphComplete).toHaveBeenCalledWith("graph-task-abc", "etag-1");
    const updateCall = mockExecuteQuery.mock.calls.find(
      (c) => /UPDATE dbo.PlannerTasks/i.test(c[1] as string) && /Status = 'resolved'/i.test(c[1] as string),
    );
    expect(updateCall).toBeDefined();
  });

  it("is idempotent — re-running on an already-active row updates LastSyncedAt without creating a duplicate", async () => {
    mockExecuteQuery
      .mockResolvedValueOnce([{
        Id: 42,
        KeyNumber: "K-12",
        BuildingName: "9 Cavanagh",
        Status: "lost",
        IsDeleted: false,
        LostAt: new Date("2026-05-20T00:00:00Z"),
        LostByName: "Jane Smith",
        LostComment: null,
        TenancyName: null,
      }])
      .mockResolvedValueOnce([{ Id: 99, PlannerTaskId: "graph-task-abc", Status: "active" }])
      .mockResolvedValueOnce([]);
    mockGraphGet.mockResolvedValue({ etag: "etag-1" });

    await syncKeyLostReported(42, baseDeps);

    expect(mockGraphCreate).not.toHaveBeenCalled();
    expect(mockGraphComplete).not.toHaveBeenCalled();
  });
});
