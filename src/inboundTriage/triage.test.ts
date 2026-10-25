import { _setAccessLoggingForTests } from "../access/accessEvents";
import { record } from "../ledger";
import { freshState, fakeExecute, type FakeState } from "../__tests__/fixtures/inboundTriageFakeDb";
import { readWithAi } from "./aiStep";
import { triageEmail, acceptRanked, AUTOMATIC } from "./triage";
import type { TriageEmail } from "./context";
import { rulesRanker } from "./rulesRanker";
import { candidate } from "../__tests__/fixtures/inboundTriageBuilders";
import type { Ranker, ScoredCandidate } from "./types";

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("./aiStep", () => ({ readWithAi: jest.fn().mockResolvedValue(null) }));
jest.mock("./sendLookup", () => ({ findSendByInternetMessageId: jest.fn().mockResolvedValue(null) }));

const db = jest.requireMock("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const lookup = jest.requireMock("./sendLookup") as { findSendByInternetMessageId: jest.Mock };
const connection = {} as never;
const NOW = new Date("2026-10-24T02:00:00Z");

const EMAIL: TriageEmail = {
  aiClassification: null, aiFlagged: false, aiParsedData: null, body: "The air con is broken and it is too hot.", emailId: 5,
  fromAddress: "tenant@acme.example", inReplyTo: null, isTest: false, mailbox: "notices@randazzo.properties", matchedJobId: null,
  receivedAt: NOW, referenceIds: null, senderAuthenticated: true, subject: "Air con",
};

let state: FakeState;
const run = (email: TriageEmail = EMAIL, over: { dryRun?: boolean; ranker?: Ranker } = {}) =>
  triageEmail(connection, email, { dryRun: over.dryRun ?? false, inactivityDays: 7, now: NOW, ranker: over.ranker ?? rulesRanker });
const writesTo = (pattern: RegExp) => state.writes.filter((write) => pattern.test(write.sql));

const job = (user: number, over: Record<string, unknown> = {}) => ({ AssignedToUserID: user, BuildingID: 10, Category: "HVAC / mechanical", CreatedAt: new Date("2026-10-10T00:00:00Z"), IsOpen: 0, TenantID: null, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  _setAccessLoggingForTests(null);
  state = freshState();
  state.staff = [
    { name: "Fay Facilities", role: "facilities", userId: 1 },
    { name: "Mo Manager", role: "facilities_manager", userId: 2 },
    { name: "Ann Accounts", role: "accounts", userId: 3 },
  ];
  state.tenancies = [{ BuildingId: 10, Name: "Acme Pty Ltd", TenantId: 9 }];
  db.executeQuery.mockImplementation(fakeExecute(state));
  db.beginTransaction.mockResolvedValue(undefined);
  (readWithAi as jest.Mock).mockResolvedValue(null);
  lookup.findSendByInternetMessageId.mockResolvedValue(null);
});

afterAll(() => _setAccessLoggingForTests(null));

describe("triageEmail: a strong match is assigned automatically", () => {
  beforeEach(() => {
    // Fay has five recent HVAC jobs at the building and an open one for this tenancy.
    state.jobs = [...Array.from({ length: 5 }, () => job(1)), job(1, { IsOpen: 1, TenantID: 9 })];
  });

  it("assigns the leader with their reasons, logs the set and the outcome, and ledgers it as the system", async () => {
    const result = await run();
    expect(result).toMatchObject({ chosen: { name: "Fay Facilities", userId: 1 }, decision: "auto", rule: "clear_leader" });

    const [update] = writesTo(/UPDATE dbo\.Emails/);
    expect(update.params).toMatchObject({ AssignedBy: AUTOMATIC, EmailId: 5, UserId: 1 });
    expect(String(update.params.Reason)).toContain("Has an open job for Acme Pty Ltd");

    expect(writesTo(/INSERT INTO dbo\.EmailRoutingSets/)[0].params).toMatchObject({ Decision: "auto", FeatureSchemaVersion: "triage-features@1", Intent: "maintenance_request", Lane: "facilities", RankerVersion: "rules@1", WorkSource: "rules" });
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingItems/).map((write) => write.params.UserId)).toEqual([1, 2]);
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingOutcomes/)[0].params).toMatchObject({ ActorOid: null, ChosenRank: 1, ChosenUserId: 1, Outcome: "auto_assigned" });
    expect(record).toHaveBeenCalledWith(connection, expect.objectContaining({ action: "email.auto_assign", actor: { kind: "system", name: "inboundTriage" }, ruleApplied: "clear_leader", subject: { id: 5, type: "email" }, tenantId: 9 }));
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("logs the exact feature vector each person was ranked on", async () => {
    await run();
    const first = JSON.parse(String(writesTo(/INSERT INTO dbo\.EmailRoutingItems/)[0].params.FeaturesJson));
    expect(first).toMatchObject({ jobsHere90d: 6, jobsHereCategory90d: 6, openJobs: 1, ownsOpenJobForTenancy: true, roleFit: "lane_staff" });
  });

  it("does not store the sender's address or the recipient's in the log", async () => {
    await run();
    const context = String(writesTo(/INSERT INTO dbo\.EmailRoutingSets/)[0].params.ContextJson);
    expect(context).not.toContain("tenant@acme.example");
    expect(JSON.parse(context)).toMatchObject({ buildingName: "Frogmore House", senderKind: "tenancy", tenancyName: "Acme Pty Ltd" });
  });

  it("changes nothing when the assignment lost a race with a manager, and says it skipped", async () => {
    state.assignmentRaces = true;
    const result = await run();
    expect(result).toMatchObject({ chosen: null, decision: "skipped", setId: null });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("rolls the whole thing back and throws when a write fails, so no half-logged assignment is kept", async () => {
    const execute = fakeExecute(state);
    db.executeQuery.mockImplementation(async (...call: unknown[]) => {
      if (/INSERT INTO dbo\.EmailRoutingOutcomes/.test(String(call[1]))) throw new Error("deadlocked");
      return execute(...call);
    });
    await expect(run()).rejects.toThrow("deadlocked");
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});

describe("triageEmail: a weak match goes to the manager's queue", () => {
  it("logs a queued set with the top people, assigns nobody and ledgers nothing", async () => {
    const result = await run();
    expect(result).toMatchObject({ chosen: null, decision: "queued", rule: "weak_match", setId: 100 });
    expect(writesTo(/UPDATE dbo\.Emails/)).toHaveLength(0);
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingSets/)[0].params.Decision).toBe("queued");
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingItems/)).toHaveLength(2);
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingOutcomes/)).toHaveLength(0);
    expect(record).not.toHaveBeenCalled();
  });

  it("queues with no names when nobody is eligible (everyone away), rather than failing", async () => {
    state.leave = [1, 2];
    const result = await run();
    expect(result).toMatchObject({ chosen: null, decision: "queued", rule: "no_candidates" });
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingItems/)).toHaveLength(0);
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingSets/)[0].params.CandidateCount).toBe(0);
  });
});

describe("triageEmail: leave and inactivity", () => {
  it("never chooses someone on leave, even the person with all the evidence", async () => {
    state.jobs = [...Array.from({ length: 5 }, () => job(1)), job(1, { IsOpen: 1, TenantID: 9 })];
    state.leave = [1];
    const result = await run();
    expect(result.chosen?.userId).not.toBe(1);
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingItems/).map((write) => write.params.UserId)).not.toContain(1);
  });

  it("never chooses someone not seen for the threshold when access logging is on and its log is old enough", async () => {
    _setAccessLoggingForTests(true);
    state.jobs = [...Array.from({ length: 5 }, () => job(1)), job(1, { IsOpen: 1, TenantID: 9 })];
    state.accessLogStart = new Date("2026-08-01T00:00:00Z");
    state.lastActive = { 1: new Date("2026-10-01T00:00:00Z"), 2: new Date("2026-10-23T00:00:00Z") };
    await run();
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingItems/).map((write) => write.params.UserId)).toEqual([2]);
  });

  it("holds nobody back for inactivity when access logging is off", async () => {
    _setAccessLoggingForTests(false);
    state.accessLogStart = new Date("2026-08-01T00:00:00Z");
    await run();
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingItems/).map((write) => write.params.UserId)).toEqual([1, 2]);
  });
});

describe("triageEmail: replies to a send", () => {
  const SEND = { buildingId: 10, jobId: null, kind: "broadcast", recipientEmail: "tenant@acme.example", sendId: "send-1", sentByUserId: 3, subject: "Water shut-off", tenancyId: 9 };
  const REPLY = { ...EMAIL, body: "Thanks, noted.", inReplyTo: "parent@x", referenceIds: "root@x parent@x", subject: "Re: Water shut-off" };

  it("looks the send up by the ids in the reply's headers, through the interface", async () => {
    await run(REPLY);
    expect(lookup.findSendByInternetMessageId).toHaveBeenCalledWith(connection, ["root@x", "parent@x"]);
  });

  it("assigns the reply to whoever sent the send, even outside the lane, and links the email to it", async () => {
    lookup.findSendByInternetMessageId.mockResolvedValue(SEND);
    const result = await run(REPLY);
    expect(result).toMatchObject({ chosen: { userId: 3 }, decision: "auto", rule: "reply_to_known_send" });
    const link = writesTo(/UPDATE dbo\.Emails\s+SET LinkedSendKind/)[0];
    expect(link.params).toMatchObject({ EmailId: 5, Kind: "broadcast", SendId: "send-1", Subject: "Water shut-off" });
    expect(String(writesTo(/UPDATE dbo\.Emails\s+SET AssignedToUserId/)[0].params.Reason)).toContain("Sent the message this is a reply to");
    expect(JSON.parse(String(writesTo(/INSERT INTO dbo\.EmailRoutingSets/)[0].params.ContextJson)).linkedSend.recipientEmail).toBeNull();
  });

  it("does not assign to the send's sender when they are on leave: it ranks the rest and queues", async () => {
    lookup.findSendByInternetMessageId.mockResolvedValue(SEND);
    state.leave = [3];
    const result = await run(REPLY);
    expect(result.decision).toBe("queued");
  });

  it("carries on unlinked when the lookup fails", async () => {
    lookup.findSendByInternetMessageId.mockRejectedValue(new Error("EB1 not there"));
    await expect(run(REPLY)).resolves.toMatchObject({ decision: "queued" });
    expect(writesTo(/SET LinkedSendKind/)).toHaveLength(0);
  });
});

describe("triageEmail: what the email names", () => {
  it("trusts a job number only when it is a live job, and gives the job's assignee the credit", async () => {
    state.namedJob = { AssignedToUserID: 2, BuildingID: 10, JobID: 77, TenantID: 9 };
    const result = await run({ ...EMAIL, matchedJobId: 77 });
    expect(result).toMatchObject({ chosen: { userId: 2 }, decision: "auto" });
    expect(String(writesTo(/UPDATE dbo\.Emails\s+SET AssignedToUserId/)[0].params.Reason)).toContain("Is assigned job #77, which this email names");
  });

  it("ignores a job number that does not exist", async () => {
    const result = await run({ ...EMAIL, matchedJobId: 999 });
    expect(JSON.parse(String(writesTo(/INSERT INTO dbo\.EmailRoutingSets/)[0].params.ContextJson)).matchedJobId).toBeNull();
    expect(result.decision).toBe("queued");
  });

  it("records where the reading came from: Toddler's parse, the AI, or the rules", async () => {
    await run({ ...EMAIL, aiClassification: "job", aiParsedData: JSON.stringify({ priority: "urgent" }) });
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingSets/)[0].params).toMatchObject({ Urgency: "urgent", WorkSource: "toddler" });
    expect(readWithAi).not.toHaveBeenCalled();

    state.writes.length = 0;
    (readWithAi as jest.Mock).mockResolvedValue({ buildingName: null, category: "Lifts", intent: "maintenance_request", jobNumber: null, lane: "facilities", source: "ai", tenancyName: null, urgency: "high" });
    await run();
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingSets/)[0].params).toMatchObject({ Category: "Lifts", Urgency: "high", WorkSource: "ai" });
  });
});

describe("triageEmail: dry run", () => {
  it("works out the decision and writes nothing at all", async () => {
    state.jobs = [...Array.from({ length: 5 }, () => job(1)), job(1, { IsOpen: 1, TenantID: 9 })];
    lookup.findSendByInternetMessageId.mockResolvedValue({ buildingId: 10, jobId: null, kind: "broadcast", recipientEmail: "tenant@acme.example", sendId: "s", sentByUserId: 1, subject: "x", tenancyId: 9 });
    const result = await run({ ...EMAIL, inReplyTo: "p@x" }, { dryRun: true });
    expect(result).toMatchObject({ chosen: { userId: 1 }, decision: "auto", setId: null });
    expect(state.writes).toHaveLength(0);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe("a replaceable ranker", () => {
  const people = [candidate(1, "Fay"), candidate(2, "Gus")];
  const scored = (userId: number, score: number): ScoredCandidate => ({ ...people[userId - 1], reasons: [], score });

  it("is used by triage without any change to the caller", async () => {
    const standIn: Ranker = { rank: () => [{ ...scored(2, 99), reasons: [{ caution: false, text: "Stand-in says so" }] }, scored(1, 1)], version: "standin@1" };
    const result = await run(EMAIL, { ranker: standIn });
    expect(result).toMatchObject({ chosen: { userId: 2 }, decision: "auto" });
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingSets/)[0].params.RankerVersion).toBe("standin@1");
  });

  it("can name only people it was given: an invented id, a repeat or a non-number cannot be assigned", () => {
    const ranked = acceptRanked(people, [scored(1, 5), { ...scored(1, 9) }, { ...scored(2, Number.NaN) }, { ...scored(2, 3), userId: 777 }]);
    expect(ranked.map((item) => item.userId)).toEqual([1]);
  });

  it("clips what a ranker says: a few short sentences", () => {
    const [item] = acceptRanked(people, [{ ...scored(1, 5), reasons: Array.from({ length: 20 }, (_, i) => ({ caution: false, text: `${i} ${"x".repeat(500)}` })) }]);
    expect(item.reasons).toHaveLength(8);
    expect(item.reasons[0].text.length).toBe(200);
  });
});

describe("triageEmail: a sender that could not be verified (forged From)", () => {
  const FORGED: TriageEmail = { ...EMAIL, senderAuthenticated: false, subject: "New bank details for rent", body: "Please update the bank details for our rent payments." };

  beforeEach(() => {
    // Everything a forger could imitate: a tenancy contact with an open job and history, and a reply to a send.
    state.jobs = [...Array.from({ length: 5 }, () => job(1)), job(1, { IsOpen: 1, TenantID: 9 })];
    lookup.findSendByInternetMessageId.mockResolvedValue({ buildingId: 10, jobId: null, kind: "broadcast", recipientEmail: "tenant@acme.example", sendId: "s", sentByUserId: 1, subject: "Notice", tenancyId: 9 });
  });

  it("is never assigned automatically and goes to the queue, however well it imitates a tenant", async () => {
    const result = await run({ ...FORGED, inReplyTo: "p@x" });
    expect(result).toMatchObject({ chosen: null, decision: "queued", rule: "sender_unverified" });
    expect(writesTo(/UPDATE dbo\.Emails\s+SET AssignedToUserId/)).toHaveLength(0);
    expect(writesTo(/INSERT INTO dbo\.EmailRoutingSets/)[0].params.Decision).toBe("queued");
    expect(record).not.toHaveBeenCalled();
  });

  it("does not look the sender up as a tenancy contact, a contractor or staff, nor look up the send it claims to answer", async () => {
    await run({ ...FORGED, inReplyTo: "p@x" });
    const sql = db.executeQuery.mock.calls.map((call) => String(call[1]));
    expect(sql.some((text) => /PrimaryContactEmail|FROM dbo\.Contractors WHERE EmailAddress|AppUsers WHERE Email/.test(text))).toBe(false);
    expect(lookup.findSendByInternetMessageId).not.toHaveBeenCalled();
    expect(writesTo(/SET LinkedSendKind/)).toHaveLength(0);
  });

  it("logs a context that says the sender was not verified, with no sender-based evidence in it", async () => {
    await run({ ...FORGED, inReplyTo: "p@x" });
    const context = JSON.parse(String(writesTo(/INSERT INTO dbo\.EmailRoutingSets/)[0].params.ContextJson));
    expect(context).toMatchObject({ linkedSend: null, replyVerified: false, senderKind: "unknown", senderVerified: false, tenancyId: null });
    const features = writesTo(/INSERT INTO dbo\.EmailRoutingItems/).map((write) => JSON.parse(String(write.params.FeaturesJson)));
    expect(features.every((vector) => vector.sentLinkedSend === false && vector.ownsOpenJobForTenancy === false)).toBe(true);
  });

  it("puts a plain warning on every suggestion, first", async () => {
    await run(FORGED);
    const reasons = writesTo(/INSERT INTO dbo\.EmailRoutingItems/).map((write) => JSON.parse(String(write.params.ReasonsJson)));
    expect(reasons.length).toBeGreaterThan(0);
    for (const list of reasons) expect(list[0]).toEqual({ caution: true, text: "The sender could not be verified, so this email may not be from who it says." });
  });

  it("treats an email whose sender was never checked (null) the same way", async () => {
    expect((await run({ ...FORGED, senderAuthenticated: null })).rule).toBe("sender_unverified");
  });

  it("still assigns a verified email as before", async () => {
    expect((await run({ ...EMAIL, subject: "Air con" })).decision).toBe("auto");
  });
});

describe("triageEmail: a verified reply from someone other than the recipient", () => {
  const SEND = { buildingId: 10, jobId: null, kind: "broadcast", recipientEmail: "tenant@acme.example", sendId: "s", sentByUserId: 3, subject: "Notice", tenancyId: 9 };
  const REPLY = { ...EMAIL, body: "Thanks, noted.", inReplyTo: "parent@x", subject: "Re: Notice" };

  it("is queued with a warning, not assigned to whoever sent the send", async () => {
    lookup.findSendByInternetMessageId.mockResolvedValue(SEND);
    const result = await run({ ...REPLY, fromAddress: "someone.else@elsewhere.example" });
    expect(result).toMatchObject({ chosen: null, decision: "queued", rule: "reply_unverified" });
    const reasons = JSON.parse(String(writesTo(/INSERT INTO dbo\.EmailRoutingItems/)[0].params.ReasonsJson));
    expect(reasons[0]).toEqual({ caution: true, text: "Replies to a message Floorplan sent, but not from the address it was sent to." });
  });

  it("is assigned when it comes from the recipient's address, whatever its case", async () => {
    lookup.findSendByInternetMessageId.mockResolvedValue(SEND);
    const result = await run({ ...REPLY, fromAddress: "Tenant@Acme.Example" });
    expect(result).toMatchObject({ chosen: { userId: 3 }, decision: "auto", rule: "reply_to_known_send" });
  });

  it("is queued when the send has no recorded recipient address to compare", async () => {
    lookup.findSendByInternetMessageId.mockResolvedValue({ ...SEND, recipientEmail: null });
    expect((await run(REPLY)).rule).toBe("reply_unverified");
  });
});
