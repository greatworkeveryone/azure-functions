/// <reference types="jest" />
// The lease event machine (PLAN §3.5, §3.6): every legal transition and the
// facts each guard needs. The frontend's copy is byte-identical (checked here).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canLeaseEventTransition,
  isOpenLeaseEventState,
  LEASE_EVENT_EVENTS,
  LEASE_EVENT_STATES,
  type LeaseEventEvent,
  type LeaseEventState,
  nextLeaseEventState,
  OPEN_LEASE_EVENT_STATES,
  typeOfState,
} from "../leaseEventMachine";

const OPTION = "option_exercise" as const;
const RENEWAL = "renewal" as const;

describe("option exercise", () => {
  it("opens in the window state today says", () => {
    expect(nextLeaseEventState(OPTION, null, "OPEN_OPTION", { windowOpen: true })).toBe("window_open");
    expect(nextLeaseEventState(OPTION, null, "OPEN_OPTION", { windowOpen: false })).toBe("window_not_open");
    expect(nextLeaseEventState(OPTION, null, "OPEN_OPTION")).toBe("window_not_open");
  });

  it("opens the window only with the fact", () => {
    expect(nextLeaseEventState(OPTION, "window_not_open", "OPEN_WINDOW", { windowOpen: true })).toBe("window_open");
    expect(nextLeaseEventState(OPTION, "window_not_open", "OPEN_WINDOW")).toBeNull();
    expect(nextLeaseEventState(OPTION, "window_open", "OPEN_WINDOW", { windowOpen: true })).toBeNull();
  });

  it("sends a notice inside the window for approval and one outside it to the directors", () => {
    for (const from of ["window_not_open", "window_open", "lapsed"] as LeaseEventState[]) {
      expect(nextLeaseEventState(OPTION, from, "RECORD_NOTICE", { noticeInWindow: true })).toBe("awaiting_approval");
      expect(nextLeaseEventState(OPTION, from, "RECORD_NOTICE", { noticeInWindow: false })).toBe("notice_received");
      expect(nextLeaseEventState(OPTION, from, "RECORD_NOTICE")).toBe("notice_received");
    }
    expect(nextLeaseEventState(OPTION, "awaiting_approval", "RECORD_NOTICE", { noticeInWindow: true })).toBeNull();
    expect(nextLeaseEventState(OPTION, "exercised", "RECORD_NOTICE", { noticeInWindow: true })).toBeNull();
  });

  it("approves from awaiting_approval, and from notice_received only with a director's override", () => {
    expect(nextLeaseEventState(OPTION, "awaiting_approval", "APPROVE")).toBe("exercised");
    expect(nextLeaseEventState(OPTION, "notice_received", "APPROVE")).toBeNull();
    expect(nextLeaseEventState(OPTION, "notice_received", "APPROVE", { directorOverride: true })).toBe("exercised");
    expect(nextLeaseEventState(OPTION, "window_open", "APPROVE", { directorOverride: true })).toBeNull();
  });

  it("rejects a recorded notice; lapses an unanswered window only past the deadline", () => {
    expect(nextLeaseEventState(OPTION, "notice_received", "REJECT")).toBe("rejected");
    expect(nextLeaseEventState(OPTION, "awaiting_approval", "REJECT")).toBe("rejected");
    expect(nextLeaseEventState(OPTION, "window_open", "REJECT")).toBeNull();
    expect(nextLeaseEventState(OPTION, "window_open", "LAPSE", { deadlinePassed: true })).toBe("lapsed");
    expect(nextLeaseEventState(OPTION, "window_not_open", "LAPSE", { deadlinePassed: true })).toBe("lapsed");
    expect(nextLeaseEventState(OPTION, "window_open", "LAPSE")).toBeNull();
    expect(nextLeaseEventState(OPTION, "awaiting_approval", "LAPSE", { deadlinePassed: true })).toBeNull();
  });
});

describe("renewal", () => {
  it("is referred, then decided as one of the three outcomes", () => {
    expect(nextLeaseEventState(RENEWAL, null, "REFER_RENEWAL")).toBe("referred");
    for (const outcome of ["renewed", "vacating", "holdover"] as const) {
      expect(nextLeaseEventState(RENEWAL, "referred", "DECIDE_RENEWAL", { outcome })).toBe(outcome);
    }
    expect(nextLeaseEventState(RENEWAL, "referred", "DECIDE_RENEWAL")).toBeNull();
    expect(nextLeaseEventState(RENEWAL, "referred", "DECIDE_RENEWAL", { outcome: "exercised" as never })).toBeNull();
    expect(nextLeaseEventState(RENEWAL, "renewed", "DECIDE_RENEWAL", { outcome: "holdover" })).toBeNull();
  });
});

describe("the two types stay apart", () => {
  it("refuses an option event on a renewal and the other way round", () => {
    expect(nextLeaseEventState(RENEWAL, null, "OPEN_OPTION", { windowOpen: true })).toBeNull();
    expect(nextLeaseEventState(OPTION, null, "REFER_RENEWAL")).toBeNull();
    expect(nextLeaseEventState(RENEWAL, "awaiting_approval", "APPROVE")).toBeNull();
    expect(nextLeaseEventState(OPTION, "referred", "DECIDE_RENEWAL", { outcome: "renewed" })).toBeNull();
  });

  it("cancels any open event of either type, and nothing closed", () => {
    for (const state of OPEN_LEASE_EVENT_STATES) {
      const type = typeOfState(state) ?? OPTION;
      expect(nextLeaseEventState(type, state, "CANCEL")).toBe("cancelled");
    }
    for (const state of LEASE_EVENT_STATES.filter((s) => !isOpenLeaseEventState(s))) {
      expect(canLeaseEventTransition(typeOfState(state) ?? OPTION, state, "CANCEL")).toBe(false);
    }
  });

  it("ignores an event name that is not a rule", () => {
    expect(nextLeaseEventState(OPTION, null, "constructor" as LeaseEventEvent)).toBeNull();
    expect(LEASE_EVENT_EVENTS).toHaveLength(9);
  });
});

describe("open states", () => {
  it("are the five a decision is still owed in; lapsed is not one", () => {
    expect([...OPEN_LEASE_EVENT_STATES].sort()).toEqual(["awaiting_approval", "notice_received", "referred", "window_not_open", "window_open"]);
    expect(isOpenLeaseEventState("lapsed")).toBe(false);
  });
});

describe("KEEP IN SYNC", () => {
  it("matches the frontend's copy byte for byte when the frontend checkout is beside this one", () => {
    const candidates = [
      join(__dirname, "..", "..", "..", "..", "..", "..", "command-centre", ".claude", "worktrees", "wp32-33", "src", "types", "leaseEventMachine.ts"),
      join(__dirname, "..", "..", "..", "command-centre", "src", "types", "leaseEventMachine.ts"),
    ];
    const ours = readFileSync(join(__dirname, "..", "leaseEventMachine.ts"), "utf8");
    for (const file of candidates) {
      let theirs: string | null = null;
      try {
        theirs = readFileSync(file, "utf8");
      } catch {
        theirs = null;
      }
      if (theirs !== null) expect(theirs).toBe(ours);
    }
  });
});
