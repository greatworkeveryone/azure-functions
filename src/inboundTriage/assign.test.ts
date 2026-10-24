import { record } from "../ledger";
import { assignEmail } from "./assign";
import { features } from "../__tests__/fixtures/inboundTriageBuilders";

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));

const db = jest.requireMock("../db") as { commitTransaction: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const connection = {} as never;
const NOW = new Date("2026-10-24T02:00:00Z");
const ACTOR = { ledger: { kind: "user" as const, name: "Mo Manager", role: "facilities_manager", userId: 2 }, name: "Mo Manager", oid: "mo-oid" };

interface World {
  email: Record<string, unknown> | null;
  leave: number[];
  raced: boolean;
  set: { Decision: string; FeatureSchemaVersion: string; IsTest: boolean; SetId: number; ContextJson: string } | null;
  items: Record<string, unknown>[];
  user: Record<string, unknown> | null;
  writes: { params: Record<string, unknown>; sql: string }[];
}
let world: World;

const CONTEXT = { buildingId: 10, buildingName: "Frogmore House", category: "Electrical", contractorId: null, emailId: 5, intent: "maintenance_request", lane: "facilities", linkedSend: null, mailbox: "notices@randazzo.properties", matchedJobId: null, senderKind: "unknown", tenancyId: null, tenancyName: null, today: "2026-10-24", urgency: null };

beforeEach(() => {
  jest.clearAllMocks();
  world = {
    email: { AssignedToUserId: null, EmailID: 5, IsTest: false, Mailbox: "notices@randazzo.properties", MatchedJobID: null, Status: "unread" },
    items: [{ CandidateUserId: 1, FeaturesJson: JSON.stringify(features()), ReasonsJson: JSON.stringify([{ caution: false, text: "Works on maintenance" }]), Rank: 1, Score: 15 }],
    leave: [],
    raced: false,
    set: { ContextJson: JSON.stringify(CONTEXT), Decision: "queued", FeatureSchemaVersion: "triage-features@1", IsTest: false, SetId: 100 },
    user: { DisplayName: "Fay Facilities", Role: "facilities", UserID: 1 },
    writes: [],
  };
  db.executeQuery.mockImplementation(async (...call: unknown[]) => {
    const sql = String(call[1]);
    const params = Object.fromEntries(((call[2] as { name: string; value: unknown }[]) ?? []).map((p) => [p.name, p.value]));
    if (/FROM dbo\.Emails WHERE EmailID = @Id/.test(sql)) return world.email ? [world.email] : [];
    if (/FROM dbo\.AppUsers WHERE UserID = @Id/.test(sql)) return world.user && Number(params.Id) === Number(world.user.UserID) ? [world.user] : [];
    if (/FROM dbo\.LeaveRequests/.test(sql)) return world.leave.map((UserId) => ({ UserId }));
    if (/FROM dbo\.EmailRoutingSets WHERE EmailId/.test(sql)) return world.set ? [world.set] : [];
    if (/FROM dbo\.EmailRoutingItems WHERE SetId/.test(sql)) return world.items;
    if (/FROM dbo\.Jobs\s+WHERE AssignedToUserID IN/.test(sql)) return [];
    if (/INSERT INTO dbo\.EmailRoutingSets/.test(sql)) {
      world.writes.push({ params, sql });
      return [{ SetId: 200 }];
    }
    if (/UPDATE dbo\.Emails/.test(sql)) {
      world.writes.push({ params, sql });
      return world.raced ? [] : [{ EmailID: 5 }];
    }
    if (/^\s*INSERT/i.test(sql)) world.writes.push({ params, sql });
    return [];
  });
});

const input = (over: Record<string, unknown> = {}) => ({ assigneeUserId: 1, emailId: 5, expectedAssigneeUserId: null, note: null, ...over }) as never;
const writesTo = (pattern: RegExp) => world.writes.filter((write) => pattern.test(write.sql));

describe("assigning an email from the queue", () => {
  it("gives it to a suggested person: accepted, with the rank, the reasons and who did it, ledgered as email.assign", async () => {
    const result = await assignEmail(connection, input(), ACTOR, NOW);
    expect(result).toEqual({ ok: true, value: { assigneeName: "Fay Facilities", assigneeUserId: 1, emailId: 5, outcome: "accepted", previousUserId: null } });
    const [update] = writesTo(/UPDATE dbo\.Emails/);
    expect(update.params).toMatchObject({ AssignedBy: "Mo Manager", EmailId: 5, Expected: null, UserId: 1 });
    expect(String(update.params.Reason)).toBe("Assigned by Mo Manager\nWorks on maintenance");
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingOutcomes/)[0].params).toMatchObject({ ActorName: "Mo Manager", ActorOid: "mo-oid", ChosenFeaturesJson: null, ChosenRank: 1, ChosenUserId: 1, Outcome: "accepted", PreviousUserId: null, SetId: 100 });
    expect(record).toHaveBeenCalledWith(connection, expect.objectContaining({ action: "email.assign", actor: ACTOR.ledger, subject: { id: 5, type: "email" } }));
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingSets/)).toHaveLength(0);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("someone not suggested is chose_other, with their features captured as the ranker would have seen them", async () => {
    world.user = { DisplayName: "Gus Facilities", Role: "facilities", UserID: 8 };
    const result = await assignEmail(connection, input({ assigneeUserId: 8 }), ACTOR, NOW);
    expect(result).toMatchObject({ ok: true, value: { outcome: "chose_other" } });
    const outcome = writesTo(/INSERT INTO dbo\.EmailRoutingOutcomes/)[0].params;
    expect(outcome.ChosenRank).toBeNull();
    expect(JSON.parse(String(outcome.ChosenFeaturesJson))).toMatchObject({ openJobs: 0, roleFit: "lane_staff" });
  });

  it("an email triage never saw gets a manual set to log the choice against", async () => {
    world.set = null;
    const result = await assignEmail(connection, input(), ACTOR, NOW);
    expect(result).toMatchObject({ ok: true, value: { outcome: "chose_other" } });
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingSets/)[0].params).toMatchObject({ ActorName: "Mo Manager", CandidateCount: 0, Decision: "manual", RankerVersion: "manual@1" });
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingOutcomes/)[0].params.SetId).toBe(200);
  });

  it("puts the manager's note on the email, the outcome's ledger row and nowhere else", async () => {
    await assignEmail(connection, input({ note: "She knows the tenant" }), ACTOR, NOW);
    expect(String(writesTo(/UPDATE dbo\.Emails/)[0].params.Reason)).toContain("Note: She knows the tenant");
    expect(record).toHaveBeenCalledWith(connection, expect.objectContaining({ reason: "She knows the tenant" }));
  });
});

describe("reassigning", () => {
  beforeEach(() => {
    world.email = { ...(world.email as object), AssignedToUserId: 8 };
  });

  it("moves an assigned email, records who it was moved from, and ledgers email.reassign", async () => {
    const result = await assignEmail(connection, input({ expectedAssigneeUserId: 8 }), ACTOR, NOW);
    expect(result).toMatchObject({ ok: true, value: { outcome: "reassigned", previousUserId: 8 } });
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingOutcomes/)[0].params).toMatchObject({ ChosenUserId: 1, Outcome: "reassigned", PreviousUserId: 8 });
    expect(writesTo(/UPDATE dbo\.Emails/)[0].params.Expected).toBe(8);
    expect(record).toHaveBeenCalledWith(connection, expect.objectContaining({ action: "email.reassign", before: { assignedToUserId: 8 } }));
  });

  it("is a conflict, and writes nothing, when the screen's idea of the owner is stale", async () => {
    const result = await assignEmail(connection, input({ expectedAssigneeUserId: null }), ACTOR, NOW);
    expect(result).toEqual({ error: "Someone else has changed who has this email. Refresh and try again.", ok: false, status: 409 });
    expect(world.writes).toHaveLength(0);
    expect(record).not.toHaveBeenCalled();
  });

  it("is a conflict when the owner changes between the check and the write", async () => {
    world.raced = true;
    const result = await assignEmail(connection, input({ expectedAssigneeUserId: 8 }), ACTOR, NOW);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("does nothing, and says so, when the person already has it", async () => {
    world.email = { ...(world.email as object), AssignedToUserId: 1 };
    expect(await assignEmail(connection, input({ expectedAssigneeUserId: 1 }), ACTOR, NOW)).toMatchObject({ ok: true, value: { outcome: "unchanged" } });
    expect(world.writes).toHaveLength(0);
  });
});

describe("who may be given an email", () => {
  it("refuses a missing email, one already dealt with, and someone who is not a staff member", async () => {
    world.email = null;
    expect(await assignEmail(connection, input(), ACTOR, NOW)).toMatchObject({ ok: false, status: 404 });
    world.email = { AssignedToUserId: null, EmailID: 5, IsTest: false, Mailbox: null, MatchedJobID: null, Status: "archived" };
    expect(await assignEmail(connection, input(), ACTOR, NOW)).toEqual({ error: "This email has already been dealt with.", ok: false, status: 409 });
    world.email = { AssignedToUserId: null, EmailID: 5, IsTest: false, Mailbox: null, MatchedJobID: null, Status: "unread" };
    world.user = { DisplayName: "Dee Director", Role: "director", UserID: 1 };
    expect(await assignEmail(connection, input(), ACTOR, NOW)).toEqual({ error: "That person cannot be given Incoming email.", ok: false, status: 400 });
    world.user = null;
    expect(await assignEmail(connection, input(), ACTOR, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(world.writes).toHaveLength(0);
  });

  it("refuses someone on approved leave today", async () => {
    world.leave = [1];
    expect(await assignEmail(connection, input(), ACTOR, NOW)).toEqual({ error: "Fay Facilities is on leave today. Choose someone else.", ok: false, status: 409 });
    expect(world.writes).toHaveLength(0);
  });
});
