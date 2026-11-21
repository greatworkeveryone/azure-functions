/// <reference types="jest" />
// What each role sees of one shared portfolio, as a table. The point of the model: the director sees the director-tier
// quote, the accounts officer sees what is theirs, nothing a person cannot complete is ever in decide or do, and the
// person who raised a thing is waiting on it rather than being asked to decide it.

import { world, viewerOf, ROLES } from "../__tests__/fixtures/obligationsWorld";
import { deriveObligations, waitingOnMe } from "./derive";
import type { Obligation, ObligationGroup } from "./types";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn(), timer: jest.fn() } }));

const ids = (items: Obligation[], group: ObligationGroup): string[] => items.filter((item) => item.group === group).map((item) => item.id).sort();

const EXPECTED: Record<string, Record<ObligationGroup, string[]>> = {
  user: { decide: [], do: [], waiting: ["intake:1900000001", "leave:1"] },
  facilities: {
    decide: [],
    do: ["job:12", "job:13"],
    waiting: ["broadcast:1", "decision:1", "job:14", "quote:1", "quote:2", "timesheet:1"],
  },
  facilities_manager: {
    decide: ["broadcast:1", "decision:1", "invoice:1", "quote:2", "timesheet:1"],
    do: ["escalation:102", "intake:1900000001", "job:13", "myob_po:1"],
    waiting: ["procedure:fire-drill"],
  },
  accounts: {
    decide: ["quote:2"],
    do: [],
    waiting: ["contractor_contact:1", "invoice:1", "rent_review:r1"],
  },
  accounts_manager: {
    decide: ["broadcast:1", "contractor_contact:1", "invoice:1", "lease_option:e1", "quote:2", "rent_review:r1"],
    do: ["myob_invoice:2", "myob_po:1", "tenancy_signoff:3"],
    waiting: ["myob_proposal:1", "schedule_change:c1"],
  },
  cfo: {
    decide: ["broadcast:1", "contractor_contact:1", "escalation:101", "invoice:1", "leave:1", "myob_proposal:1", "quote:2", "rent_review:r1", "timesheet:1"],
    do: ["myob_invoice:2", "myob_po:1", "tenancy_signoff:3"],
    waiting: ["lease_option:e1"],
  },
  director: {
    decide: ["broadcast:1", "contractor_contact:1", "invoice:1", "lease_option:e1", "leave:1", "procedure:fire-drill", "quote:1", "quote:2", "rent_review:r1", "role_grant:1", "schedule_change:c1", "timesheet:1"],
    do: ["intake:1900000001", "myob_invoice:2", "myob_po:1", "tenancy_signoff:3"],
    waiting: [],
  },
  admin: { decide: [], do: ["intake:1900000001"], waiting: ["role_grant:1"] },
};

describe("what each role sees", () => {
  it.each(ROLES.map((role) => [role]))("%s", (role) => {
    const { ctx, sources } = world();
    const { items } = deriveObligations(sources, viewerOf(role), ctx);
    expect({ decide: ids(items, "decide"), do: ids(items, "do"), waiting: ids(items, "waiting") }).toEqual(EXPECTED[role]);
  });

  it("never lists anything in decide or do that the person cannot complete", () => {
    const { ctx, sources } = world();
    for (const role of ROLES) {
      const { items } = deriveObligations(sources, viewerOf(role), ctx);
      for (const item of items) expect({ role, id: item.id, ok: item.group === "waiting" || item.canAct }).toEqual({ role, id: item.id, ok: true });
    }
  });

  it("gives the director the director-tier quote and the accounts officer neither it nor a button on the first-tier one they cannot approve", () => {
    const { ctx, sources } = world();
    expect(ids(deriveObligations(sources, viewerOf("director"), ctx).items, "decide")).toContain("quote:1");
    for (const role of ["accounts", "accounts_manager", "cfo", "facilities_manager"]) {
      expect(ids(deriveObligations(sources, viewerOf(role), ctx).items, "decide")).not.toContain("quote:1");
    }
  });

  it("counts what waits on a person as decide plus do, whatever the cap leaves out", () => {
    const { ctx, sources } = world();
    const list = deriveObligations(sources, viewerOf("director"), ctx, [], 1);
    expect(waitingOnMe(list.totals)).toBe(16);
    expect(list.items.length).toBeLessThan(list.totals.decide + list.totals.do + list.totals.waiting);
    expect(list.more.decide + list.more.do).toBeGreaterThan(0);
  });

  it("says which sources could not be read instead of reading as nothing waiting", () => {
    const { ctx, sources } = world();
    expect(deriveObligations(sources, viewerOf("director"), ctx, ["quotes"]).unavailable).toEqual(["quotes"]);
  });
});
