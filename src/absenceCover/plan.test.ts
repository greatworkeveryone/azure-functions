/// <reference types="jest" />
import { absent, context, item } from "../__tests__/fixtures/absenceCover";
import type { CoverActionRow } from "./coverActionStore";
import { planCover, reasonTextFor } from "./plan";
import type { CoverItem } from "./types";

const due = (iso: string) => new Date(`${iso}T02:00:00Z`);
const last = (over: Partial<CoverActionRow> = {}): CoverActionRow => ({
  absenceKind: "planned",
  absenceRef: "leave:11",
  action: "suggested",
  actorKind: "system",
  actorName: "Floorplan",
  actorUserId: null,
  coverActionId: 1,
  createdAt: new Date(),
  dryRun: false,
  dueAt: null,
  fromUserId: 1,
  importance: "medium",
  itemId: "12",
  itemLabel: "x",
  itemType: "job",
  reasonCode: "x",
  reasonText: "x",
  relatedActionId: null,
  returnDate: null,
  runId: null,
  toUserId: null,
  ...over,
});
const plan = (items: CoverItem[], latest: CoverActionRow[] = [], over = {}) =>
  planCover({ absent: [absent()], context: context(over), items, latest: new Map(latest.map((row) => [`${row.itemType}:${row.itemId}`, row])) });

describe("planCover", () => {
  it("moves what falls due before they are back and suggests the rest", () => {
    const result = plan([item({ dueAt: due("2026-10-28"), id: "1" }), item({ dueAt: due("2026-11-10"), id: "2" })]);
    expect(result.entries.map((entry) => [entry.item.id, entry.action])).toEqual([["1", "reassigned"], ["2", "suggested"]]);
    expect(result.entries[0].reasonCode).toBe("due_before_return");
    expect(result.entries[1].reasonCode).toBe("due_after_return");
  });

  it("orders by importance, then by due date, then by item", () => {
    const result = plan([
      item({ dueAt: due("2026-10-30"), id: "1", importance: "medium" }),
      item({ dueAt: due("2026-10-29"), id: "2", importance: "medium" }),
      item({ dueAt: due("2026-11-20"), id: "3", importance: "high" }),
      item({ dueAt: null, id: "4", importance: "medium" }),
    ]);
    expect(result.entries.map((entry) => entry.item.id)).toEqual(["3", "2", "1", "4"]);
  });

  it("only suggests when nobody can take it, with the reason in words", () => {
    const result = plan([item({ dueAt: due("2026-10-28") })], [], { directory: [context().directory[0]] });
    expect(result.entries[0]).toMatchObject({ action: "suggested", reasonCode: "no_cover" });
    expect(result.entries[0].reasonText).toContain("Nobody who may take it is available");
  });

  it("only suggests an item that cannot be moved from here, even with a cover", () => {
    const leaveApproval = item({ capability: null, dueAt: due("2026-10-28"), move: "none", type: "leave_approval" });
    const result = plan([leaveApproval], [], { absentIds: new Set([1]) });
    expect(result.entries[0]).toMatchObject({ action: "suggested", reasonCode: "not_movable" });
    expect(result.entries[0].resolution.found).toBe(true);
  });

  it("names the escalation when the cover came from up the ladder", () => {
    const result = plan([item({ dueAt: due("2026-10-28") })], [], { absentIds: new Set([1, 2, 8]) });
    expect(result.entries[0].action).toBe("escalated");
    expect(result.entries[0].reasonText).toContain("Escalated to Cam Cfo, the next person up the escalation ladder.");
  });

  it("leaves an item alone that its owner can only answer themselves", () => {
    const result = plan([item({ personal: true })]);
    expect(result.entries).toEqual([]);
    expect(result.stayed).toBe(1);
  });

  it("ignores an item whose owner is not away", () => {
    expect(plan([item({ ownerUserId: 3 })]).entries).toEqual([]);
  });

  describe("a shared queue is only at risk when nobody else is in", () => {
    const quote = item({ capability: null, dueAt: due("2026-10-28"), money: { amount: 500, buildingId: 3, createdByName: null, subject: "quote" }, move: "notice", type: "approval" });

    it("drops a quote another approver could take", () => {
      const result = plan([quote]);
      expect(result.entries).toEqual([]);
      expect(result.notStranded).toBe(1);
    });

    it("keeps it when everyone who could approve is away", () => {
      const everyone = new Set([1, 2, 3, 4, 5, 6, 8]);
      const result = plan([quote], [], { absentIds: everyone });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].resolution.found).toBe(false);
    });
  });

  describe("idempotent by what the ledger says", () => {
    const soon = item({ dueAt: due("2026-11-10") });

    it("keeps the latest row on the entry so the engine can see a suggestion already made", () => {
      expect(plan([soon], [last()]).entries[0].last?.action).toBe("suggested");
    });

    it.each(["kept", "taken_back"] as const)("leaves an item alone that was %s for this absence", (action) => {
      const result = plan([soon], [last({ action, fromUserId: action === "taken_back" ? 2 : 1, toUserId: action === "taken_back" ? 1 : null })]);
      expect(result.entries).toEqual([]);
      expect(result.alreadyHandled).toBe(1);
    });

    it("looks at it again for a new absence", () => {
      expect(plan([soon], [last({ absenceRef: "leave:5", action: "kept" })]).entries).toHaveLength(1);
    });

    it("looks at it again when it was kept for someone else's absence", () => {
      expect(plan([soon], [last({ action: "kept", fromUserId: 3, toUserId: null })]).entries).toHaveLength(1);
    });
  });
});

describe("reasonTextFor", () => {
  it("says why, who is away, who was passed over and who has it", () => {
    const entry = plan([item({ dueAt: due("2026-10-28") })], [], { delegates: [{ coverDelegateId: 1, delegateUserId: 7, fromDate: "2026-10-26", leaveRequestId: 11, toDate: "2026-10-30", userId: 1 }], absentIds: new Set([1, 7]) }).entries[0];
    expect(entry.reasonText).toBe(
      "It falls due before they are back. On annual leave until 30/10/2026. the cover they nominated was passed over: they is away too. Moved to Max Manager, their team manager.",
    );
    expect(reasonTextFor(entry, "suggested")).toContain("Suggested cover Max Manager");
  });
});
