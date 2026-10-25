/// <reference types="jest" />
import { ITEM_TYPES } from "../types";
import { canTakeBack, isMovable, MOVE_KIND_OF, MOVERS } from "./domain";

describe("how each kind of item changes hands", () => {
  it("knows a move kind for every item type the ledger allows", () => {
    expect(Object.keys(MOVE_KIND_OF).sort()).toEqual([...ITEM_TYPES].sort());
  });

  it("moves jobs, decision requests, escalations and emails through their own mover", () => {
    for (const type of ["job", "decision_request", "escalation", "email"] as const) {
      expect(MOVERS[MOVE_KIND_OF[type]]).toEqual(expect.any(Function));
      expect(isMovable(MOVE_KIND_OF[type])).toBe(true);
      expect(canTakeBack(MOVE_KIND_OF[type])).toBe(true);
    }
  });

  it("tells a person who holds the authority about a quote, without changing it: movable, but there is nothing to take back", () => {
    expect(MOVE_KIND_OF.approval).toBe("notice");
    expect(isMovable("notice")).toBe(true);
    expect(canTakeBack("notice")).toBe(false);
  });

  it("lists a leave approval but cannot move it: who approves follows the reporting line", () => {
    expect(MOVE_KIND_OF.leave_approval).toBe("none");
    expect(isMovable("none")).toBe(false);
    expect(canTakeBack("none")).toBe(false);
  });
});
