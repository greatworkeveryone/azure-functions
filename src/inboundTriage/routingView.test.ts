import { lanesFor, loadQueue, loadRouting, QUEUE_PAGE } from "./routingView";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const connection = {} as never;

beforeEach(() => db.executeQuery.mockReset());

const emailRow = (id: number, over: Record<string, unknown> = {}) => ({ AssigneeName: null, AssignedAt: null, AssignedBy: null, AssignedToUserId: null, AssignmentReason: null, EmailID: id, LatestDecision: null, LinkedSendSubject: null, Mailbox: null, SenderVerified: 1, ...over });
const suggestion = (emailId: number, rank: number, userId: number) => ({ CandidateUserId: userId, DisplayName: `User ${userId}`, EmailId: emailId, Rank: rank, ReasonsJson: JSON.stringify([{ caution: false, text: "Works on maintenance" }]), Score: 15 });

describe("loadRouting", () => {
  it("reads nothing for no ids", async () => {
    expect((await loadRouting(connection, [])).size).toBe(0);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("says who has an assigned email, why, who put them there, the mailbox and the send it replies to", async () => {
    db.executeQuery.mockResolvedValueOnce([emailRow(1, { AssigneeName: "Fay", AssignedAt: new Date("2026-10-24T01:00:00Z"), AssignedBy: "Floorplan (automatic)", AssignedToUserId: 4, AssignmentReason: "Sent the message this is a reply to\n\nWorks on maintenance", LatestDecision: "auto", LinkedSendSubject: "Water shut-off", Mailbox: "notices@randazzo.properties" })]).mockResolvedValueOnce([]);
    const [view] = [...(await loadRouting(connection, [1])).values()];
    expect(view).toEqual({
      assignedAt: "2026-10-24T01:00:00.000Z", assignedBy: "Floorplan (automatic)", assignee: { name: "Fay", userId: 4 }, emailId: 1,
      linkedSendSubject: "Water shut-off", mailbox: "notices@randazzo.properties", reasons: ["Sent the message this is a reply to", "Works on maintenance"], senderVerified: true, state: "assigned", suggestions: [],
    });
  });

  it("gives an email waiting for a manager its top suggestions, and an email triage never saw nothing", async () => {
    db.executeQuery.mockResolvedValueOnce([emailRow(1, { LatestDecision: "queued" }), emailRow(2), emailRow(3, { AssigneeName: "Fay", AssignedToUserId: 4, LatestDecision: "queued" })])
      .mockResolvedValueOnce([suggestion(1, 1, 4), suggestion(1, 2, 5), suggestion(2, 1, 6), suggestion(3, 1, 7)]);
    const views = await loadRouting(connection, [1, 2, 3]);
    expect(views.get(1)).toMatchObject({ state: "needs_triage", suggestions: [{ name: "User 4", rank: 1, userId: 4 }, { name: "User 5", rank: 2 }] });
    expect(views.get(2)).toMatchObject({ state: "none", suggestions: [] });
    expect(views.get(3)).toMatchObject({ state: "assigned", suggestions: [] });
  });

  it("says whether the sender was verified, and only an explicit yes counts", async () => {
    db.executeQuery.mockResolvedValueOnce([emailRow(1), emailRow(2, { SenderVerified: 0 })]).mockResolvedValueOnce([]);
    const views = await loadRouting(connection, [1, 2]);
    expect([views.get(1)?.senderVerified, views.get(2)?.senderVerified]).toEqual([true, false]);
    expect(String(db.executeQuery.mock.calls[0][1])).toContain("CASE WHEN e.SenderAuthenticated = 1 THEN 1 ELSE 0 END AS SenderVerified");
  });

  it("asks for at most each email's top three, from its newest set", async () => {
    db.executeQuery.mockResolvedValue([]);
    await loadRouting(connection, [1]);
    expect(String(db.executeQuery.mock.calls[1][1])).toContain("i.[Rank] <= 3");
    expect(String(db.executeQuery.mock.calls[1][1])).toContain("SELECT MAX(SetId)");
  });
});

describe("the manager's queue", () => {
  it("shows a manager their own team's work and the work either team may take; directors, the CFO and admin all of it", () => {
    expect(lanesFor(["facilities_manager"]).sort()).toEqual(["both", "facilities"]);
    expect(lanesFor(["accounts_manager"]).sort()).toEqual(["accounts", "both"]);
    expect(lanesFor(["facilities_manager", "accounts_manager"]).sort()).toEqual(["accounts", "both", "facilities"]);
    for (const role of ["admin", "director", "cfo"]) expect(lanesFor([role]).sort()).toEqual(["accounts", "both", "facilities"]);
  });

  it("lists queued, unassigned, open, non-test emails in the caller's lanes, oldest first, with suggestions", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Category: "Lifts", EmailID: 1, FromAddress: "t@x.co", FromName: "Tess", Intent: "maintenance_request", Lane: "facilities", Mailbox: "notices@randazzo.properties", ReceivedAt: new Date("2026-10-24T00:00:00Z"), Subject: "Lift", Urgency: "high", SenderVerified: 0 }])
      .mockResolvedValueOnce([emailRow(1, { LatestDecision: "queued" })]).mockResolvedValueOnce([suggestion(1, 1, 4)]);
    const [item] = await loadQueue(connection, ["facilities", "both"], false);
    expect(item.senderVerified).toBe(false);
    expect(item).toMatchObject({ category: "Lifts", emailId: 1, fromName: "Tess", intent: "maintenance_request", lane: "facilities", receivedAt: "2026-10-24T00:00:00.000Z", urgency: "high", suggestions: [{ userId: 4 }] });
    const sql = String(db.executeQuery.mock.calls[0][1]);
    expect(sql).toContain("e.AssignedToUserId IS NULL AND s.Decision = 'queued'");
    expect(sql).toContain("(e.IsTest = 0 OR @ShowTest = 1)");
    expect(sql).toContain("ORDER BY e.ReceivedAt");
    expect(sql).toContain(`TOP (${QUEUE_PAGE})`);
    const params = Object.fromEntries(db.executeQuery.mock.calls[0][2].map((p: { name: string; value: unknown }) => [p.name, p.value]));
    expect(JSON.parse(String(params.Lanes))).toEqual(["facilities", "both"]);
    expect(params.ShowTest).toBe(false);
  });
});
