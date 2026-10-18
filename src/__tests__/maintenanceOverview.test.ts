/// <reference types="jest" />
import { assembleOverview, type OverviewRun, type OverviewLinkedJob } from "../maintenanceOverview";
import { periodRowToApi } from "../defectsPeriods";
import { scheduleRowToApi } from "../serviceSchedules";
import { at, periodRow, scheduleRow } from "./fixtures/facilitiesHarness";

const TODAY = "2026-10-14";
const schedule = (overrides: Record<string, unknown> = {}) => scheduleRowToApi(scheduleRow(overrides), TODAY);
const run = (overrides: Partial<OverviewRun> = {}): OverviewRun => ({
  completedAt: null,
  dueDate: "2026-10-28",
  jobArchived: false,
  jobId: 500,
  jobStatus: "New",
  jobTitle: "Chiller service",
  note: null,
  outcome: "job_created",
  serviceScheduleId: 21,
  ...overrides,
});

function build(input: Partial<Parameters<typeof assembleOverview>[0]> = {}) {
  return assembleOverview({ days: 90, hasSchedules: true, linkedJobs: [], periods: [], runs: [], scheduleCount: 1, schedulerMode: "live", schedules: [schedule()], today: TODAY, ...input });
}

describe("assembleOverview", () => {
  it("groups by building then asset, the window's occurrences soonest first", () => {
    const monthly = schedule({ IntervalCount: 1, NextDue: at("2026-10-28"), ServiceScheduleId: 22, AnchorDate: at("2026-01-28"), Name: "Monthly check" });
    const overview = build({ schedules: [schedule(), monthly] });
    expect(overview).toMatchObject({ days: 90, hasSchedules: true, today: TODAY, until: "2027-01-12" });
    expect(overview.buildings).toHaveLength(1);
    const [asset] = overview.buildings[0].assets;
    expect(asset).toMatchObject({ assetId: 12, assetName: "Chiller 1", assetTag: "CH-01", key: "asset-12" });
    expect(asset.services.map((s) => [s.name, s.dueDate, s.occurrence])).toEqual([
      ["Six-monthly chiller service", "2026-10-28", 0],
      ["Monthly check", "2026-10-28", 0],
      ["Monthly check", "2026-11-28", 1],
      ["Monthly check", "2026-12-28", 2],
    ]);
  });

  it("is overdue against the service's due date, job open when its job exists, otherwise scheduled", () => {
    const overdue = schedule({ NextDue: at("2026-10-01"), ServiceScheduleId: 30, AssetId: 13, AssetName: "Lift 1", AssetTag: "L-01", Category: "Lifts" });
    const overview = build({
      runs: [run(), run({ dueDate: "2026-10-01", jobId: 501, serviceScheduleId: 30 })],
      schedules: [schedule(), overdue, schedule({ NextDue: at("2026-12-01"), ServiceScheduleId: 31, AssetId: 14, AssetName: "Pump", AssetTag: null })],
    });
    const services = overview.buildings[0].assets.flatMap((a) => a.services.filter((s) => s.occurrence === 0));
    expect(services.map((s) => [s.serviceScheduleId, s.status, s.jobId, s.urgent])).toEqual([
      [30, "overdue", 501, true],
      [21, "job_open", 500, false],
      [31, "scheduled", null, false],
    ]);
    expect(overview.buildings[0].counts).toEqual({ jobOpen: 1, overdue: 1, scheduled: 1 });
  });

  it("does not count a done or archived job as open", () => {
    const overview = build({ runs: [run({ jobStatus: "Done" })] });
    expect(overview.buildings[0].assets[0].services[0].status).toBe("scheduled");
    const archived = build({ runs: [run({ jobArchived: true })] });
    expect(archived.buildings[0].assets[0].services[0].status).toBe("scheduled");
  });

  // Review F2 finding 5: an overdue service whose job was archived said "Chase job #n" and offered no way out.
  it("doesn't offer an archived job to chase: the service is overdue with no job, and the archived one is named", () => {
    const overdue = schedule({ NextDue: at("2026-10-01") });
    const overview = build({ runs: [run({ dueDate: "2026-10-01", jobArchived: true, jobId: 501 })], schedules: [overdue] });
    const [service] = overview.buildings[0].assets[0].services;
    expect(service).toMatchObject({ archivedJobId: 501, jobId: null, jobStatus: null, status: "overdue" });
  });

  it("names an archived job only for the due date that is overdue", () => {
    const overview = build({ runs: [run({ jobArchived: true })] });
    expect(overview.buildings[0].assets[0].services[0]).toMatchObject({ archivedJobId: null, jobId: null, status: "scheduled" });
  });

  it("carries the scheduler's mode so the page doesn't promise jobs that won't be made", () => {
    expect(build({ schedulerMode: "dry-run" }).schedulerMode).toBe("dry-run");
  });

  it("knows when each asset was last serviced, from schedule runs and from linked maintenance jobs", () => {
    const overview = build({
      linkedJobs: [{ assetId: 12, completedOn: "2026-08-02", jobId: 300, jobStatus: "Done", jobTitle: "Chiller repair" } as OverviewLinkedJob],
      runs: [
        run(),
        run({ completedAt: "2026-04-30T03:00:00.000Z", dueDate: "2026-04-28", jobId: 400, jobStatus: "Done" }),
        run({ dueDate: "2025-10-28", jobId: null, outcome: "skipped_defects" }),
      ],
    });
    const [asset] = overview.buildings[0].assets;
    expect(asset.lastServiced).toEqual({ date: "2026-08-02", jobId: 300 });
    expect(asset.history.map((h) => [h.date, h.outcome, h.jobId, h.source])).toEqual([
      ["2026-10-28", "open", 500, "schedule"],
      ["2026-08-02", "done", 300, "linked_job"],
      ["2026-04-30", "done", 400, "schedule"],
      ["2025-10-28", "skipped_defects", null, "schedule"],
    ]);
  });

  it("shows a manager's mark-serviced as done and a skip with its reason (UX review E4)", () => {
    const overview = build({
      runs: [
        run({ completedAt: "2026-05-02T00:00:00.000Z", dueDate: "2026-04-28", jobId: null, jobStatus: null, note: "Contractor's own visit", outcome: "recorded" }),
        run({ dueDate: "2025-10-28", jobId: null, jobStatus: null, note: "Building closed", outcome: "skipped" }),
      ],
    });
    const [asset] = overview.buildings[0].assets;
    expect(asset.lastServiced).toEqual({ date: "2026-05-02", jobId: null });
    expect(asset.history.map((h) => [h.date, h.outcome, h.note])).toEqual([
      ["2026-05-02", "done", "Contractor's own visit"],
      ["2025-10-28", "skipped", "Building closed"],
    ]);
  });

  it("counts the schedules set up, so an empty window can say how many exist (UX review E2)", () => {
    expect(build({ scheduleCount: 150 }).scheduleCount).toBe(150);
  });

  it("groups a service without an asset under its scope", () => {
    const overview = build({ schedules: [schedule({ AssetId: null, AssetName: null, AssetTag: null, Scope: "All exit lights", ServiceScheduleId: 40 })] });
    expect(overview.buildings[0].assets[0]).toMatchObject({ assetId: null, key: "schedule-40", scope: "All exit lights" });
  });

  it("puts defects-period chips on their building, even one with no servicing due", () => {
    const period = periodRowToApi(periodRow({ BuildingId: 2, BuildingName: "Plaza" }), TODAY);
    const overview = build({ periods: [period] });
    expect(overview.buildings.map((b) => [b.buildingName, b.defectsPeriods.length, b.assets.length])).toEqual([
      ["Plaza", 1, 0],
      ["Tower A", 0, 1],
    ]);
  });

  it("lists the jobs schedules created, so the jobs list below can leave them out", () => {
    expect(build({ runs: [run(), run({ jobId: null, outcome: "skipped_defects" })] }).scheduledJobIds).toEqual([500]);
  });

  it("is empty but honest before any schedule exists", () => {
    expect(build({ hasSchedules: false, schedules: [] })).toMatchObject({ buildings: [], hasSchedules: false });
  });
});
