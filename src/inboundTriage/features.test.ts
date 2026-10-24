import { buildVectors, chooseEligible, FEATURE_SCHEMA_VERSION, roleFit, toCandidates, type EligibilityFacts } from "./features";
import type { ActivityFacts, AssignedJob, StaffRow } from "./load";
import type { TriageContext } from "./types";

const NOW = new Date("2026-10-24T02:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const STAFF: StaffRow[] = [
  { name: "Fay Facilities", role: "facilities", userId: 1 },
  { name: "Mo Manager", role: "facilities_manager", userId: 2 },
  { name: "Ann Accounts", role: "accounts", userId: 3 },
  { name: "Gus Manager", role: "accounts_manager", userId: 4 },
];

const facts = (over: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  activity: null,
  inactivityDays: 7,
  linkedSenderId: null,
  now: NOW,
  onLeave: new Set(),
  ...over,
});

const activity = (logDays: number, last: Record<number, number>): ActivityFacts => ({
  lastActive: new Map(Object.entries(last).map(([id, days]) => [Number(id), ago(days)])),
  logStartedAt: ago(logDays),
});

const ids = (people: readonly StaffRow[]) => people.map((person) => person.userId);

describe("roleFit", () => {
  it("fits staff and managers to their own lane, and both lanes to either", () => {
    expect(roleFit("facilities", "facilities")).toBe("lane_staff");
    expect(roleFit("facilities_manager", "facilities")).toBe("lane_manager");
    expect(roleFit("accounts", "facilities")).toBe("none");
    expect(roleFit("accounts", "both")).toBe("either_staff");
    expect(roleFit("accounts_manager", "both")).toBe("either_manager");
    expect(roleFit("director", "both")).toBe("none");
  });
});

describe("chooseEligible", () => {
  it("keeps the people whose role fits the lane", () => {
    expect(ids(chooseEligible(STAFF, "facilities", facts()).eligible)).toEqual([1, 2]);
    expect(ids(chooseEligible(STAFF, "accounts", facts()).eligible)).toEqual([3, 4]);
    expect(ids(chooseEligible(STAFF, "both", facts()).eligible)).toEqual([1, 2, 3, 4]);
  });

  it("leaves out anyone on approved leave covering today, and says why", () => {
    const result = chooseEligible(STAFF, "facilities", facts({ onLeave: new Set([1]) }));
    expect(ids(result.eligible)).toEqual([2]);
    expect(result.excluded).toEqual([{ reason: "leave", userId: 1 }]);
  });

  it("leaves out someone not seen for the threshold, once the log is older than the threshold", () => {
    const result = chooseEligible(STAFF, "facilities", facts({ activity: activity(60, { 1: 10, 2: 1 }) }));
    expect(ids(result.eligible)).toEqual([2]);
    expect(result.excluded).toEqual([{ reason: "inactive", userId: 1 }]);
  });

  it("counts someone with no sign-in at all as inactive when the log is old enough to say so", () => {
    expect(ids(chooseEligible(STAFF, "facilities", facts({ activity: activity(60, { 2: 0 }) })).eligible)).toEqual([2]);
  });

  it("holds nobody back for inactivity when the log is younger than the threshold or access logging is off", () => {
    expect(ids(chooseEligible(STAFF, "facilities", facts({ activity: activity(3, {}) })).eligible)).toEqual([1, 2]);
    expect(ids(chooseEligible(STAFF, "facilities", facts({ activity: { lastActive: new Map(), logStartedAt: null } })).eligible)).toEqual([1, 2]);
    expect(ids(chooseEligible(STAFF, "facilities", facts({ activity: null })).eligible)).toEqual([1, 2]);
  });

  it("someone seen just inside the threshold stays", () => {
    expect(ids(chooseEligible(STAFF, "facilities", facts({ activity: activity(60, { 1: 6.5, 2: 0 }) })).eligible)).toEqual([1, 2]);
  });

  it("keeps the sender of the send being answered whatever their lane, unless they are away", () => {
    expect(ids(chooseEligible(STAFF, "facilities", facts({ linkedSenderId: 3 })).eligible)).toEqual([1, 2, 3]);
    expect(ids(chooseEligible(STAFF, "facilities", facts({ linkedSenderId: 3, onLeave: new Set([3]) })).eligible)).toEqual([1, 2]);
  });
});

const CONTEXT: TriageContext = {
  buildingId: 10, buildingName: "Frogmore House", category: "Electrical", contractorId: null, emailId: 5, intent: "maintenance_request", lane: "facilities",
  linkedSend: null, mailbox: "notices@randazzo.properties", matchedJobId: 77, senderKind: "tenancy", tenancyId: 9, tenancyName: "Acme Pty Ltd", today: "2026-10-24", urgency: null,
};

const job = (over: Partial<AssignedJob>): AssignedJob => ({ assignedToUserId: 1, buildingId: 10, category: "Electrical", createdAt: ago(10), open: false, tenancyId: null, ...over });

describe("buildVectors", () => {
  it("counts assigned jobs here in the last 90 days, by category, and ignores older ones and other buildings", () => {
    const jobs = [job({}), job({ createdAt: ago(30) }), job({ category: "Lifts" }), job({ createdAt: ago(120) }), job({ buildingId: 11 }), job({ assignedToUserId: 3 })];
    const vector = buildVectors(STAFF, jobs, CONTEXT, { activity: null, namedJobAssignee: null, now: NOW }).get(1);
    expect(vector).toMatchObject({ jobsHere90d: 3, jobsHereCategory90d: 2 });
  });

  it("flags open work for the tenancy and the building, and counts the open workload anywhere", () => {
    const jobs = [job({ buildingId: 99, open: true, tenancyId: 9 }), job({ open: true }), job({ buildingId: 55, open: true })];
    expect(buildVectors(STAFF, jobs, CONTEXT, { activity: null, namedJobAssignee: null, now: NOW }).get(1)).toMatchObject({ openJobs: 3, ownsOpenJobForTenancy: true, ownsOpenJobHere: true });
    expect(buildVectors(STAFF, [], CONTEXT, { activity: null, namedJobAssignee: null, now: NOW }).get(1)).toMatchObject({ openJobs: 0, ownsOpenJobForTenancy: false, ownsOpenJobHere: false });
  });

  it("marks who holds the job the email names and who sent the send it answers", () => {
    const withSend: TriageContext = { ...CONTEXT, linkedSend: { buildingId: null, jobId: null, kind: "broadcast", recipientEmail: null, sendId: "s1", sentByUserId: 3, subject: "Water shut-off", tenancyId: null } };
    const vectors = buildVectors(STAFF, [], withSend, { activity: null, namedJobAssignee: 2, now: NOW });
    expect(vectors.get(2)?.ownsNamedJob).toBe(true);
    expect(vectors.get(1)?.ownsNamedJob).toBe(false);
    expect(vectors.get(3)?.sentLinkedSend).toBe(true);
    expect(vectors.get(1)?.sentLinkedSend).toBe(false);
  });

  it("measures days since last seen, null when the log has nothing for them, and records role fit", () => {
    const vectors = buildVectors(STAFF, [], CONTEXT, { activity: activity(60, { 1: 2.4 }), namedJobAssignee: null, now: NOW });
    expect(vectors.get(1)).toMatchObject({ daysSinceActive: 2, roleFit: "lane_staff" });
    expect(vectors.get(2)?.daysSinceActive).toBeNull();
    expect(vectors.get(3)?.roleFit).toBe("none");
  });

  it("makes no category claim when the email has no category", () => {
    const vector = buildVectors(STAFF, [job({})], { ...CONTEXT, category: null }, { activity: null, namedJobAssignee: null, now: NOW }).get(1);
    expect(vector).toMatchObject({ jobsHere90d: 1, jobsHereCategory90d: 0 });
  });

  it("builds candidates for exactly the people given, and the schema is versioned", () => {
    const vectors = buildVectors(STAFF.slice(0, 2), [], CONTEXT, { activity: null, namedJobAssignee: null, now: NOW });
    expect(toCandidates(STAFF, vectors).map((candidate) => candidate.userId)).toEqual([1, 2]);
    expect(FEATURE_SCHEMA_VERSION).toBe("triage-features@1");
  });
});
