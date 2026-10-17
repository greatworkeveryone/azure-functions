/// <reference types="jest" />

// The M4 final-look scenarios (17 Oct), kept in the suite, now asserting the fix:
//   D  an unregistered company-file id in printed error text is never printed
//   E  a window capped at 14 days after a longer gap says so

import { buildMyobDailyEmail } from "./email";
import { dailyWindow } from "./run";
import type { DailyFacts } from "./types";

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OPTIONS = { apiBase: "https://api.myob.com/accountright", baseUrl: null, firstName: "J", overriddenFrom: null };
const facts = (over: Partial<DailyFacts> = {}): DailyFacts => ({
  calls: [], controls: [], events: [], files: [{ id: CF, name: "Demo Pty Ltd" }],
  since: new Date("2026-10-12T22:00:00Z"), until: new Date("2026-10-13T22:00:00Z"), ...over,
});
const call = { actorKind: "user", actorName: "Will", httpStatus: null, method: "GET", occurredAt: new Date("2026-10-13T01:00:00Z"), phase: "error" as const };

it("D: an unregistered company file's id in error text becomes 'a company file Floorplan isn't set up for'", () => {
  const email = buildMyobDailyEmail(facts({
    calls: [
      { ...call, errorMessage: `MYOB is off for company file ${OTHER.toUpperCase()}: the CFO has not switched this file on (Entities)`, path: "/accountright/", purpose: "test-connection" },
      { ...call, errorMessage: `MYOB is off for company file ${CF}: read only`, path: `/accountright/${CF}/Purchase/Order/Service`, purpose: "find-order-by-number" },
    ],
  }), OPTIONS)!;
  expect(email.body.toLowerCase()).not.toContain(OTHER);
  expect(email.body).toContain("MYOB is off for a company file Floorplan isn't set up for: the CFO has not switched this file on");
  expect(email.body).toContain(`MYOB is off for company file ${CF}: read only`);
});

it("D: a bare mention of the configured file is withheld until the CFO registers it", () => {
  const refused = { ...call, errorMessage: `Linked to ${OTHER}; register it in Admin → MYOB first`, path: "/accountright/", purpose: "files" };
  const unregistered = buildMyobDailyEmail(facts({ calls: [refused] }), { ...OPTIONS, configuredFile: OTHER })!;
  expect(unregistered.body).toContain("Linked to a company file Floorplan isn't set up for; register it");
  const registered = buildMyobDailyEmail(facts({ calls: [refused], files: [{ id: CF, name: "Demo" }, { id: OTHER, name: "Other" }] }), { ...OPTIONS, configuredFile: OTHER })!;
  expect(registered.body).toContain(`Linked to ${OTHER}`);
});

it("D: the same holds for proposal exception reasons", () => {
  const email = buildMyobDailyEmail(facts({
    events: [{
      action: "myob.exception", actorName: "Johanne", after: null, companyFileId: CF, companyFileName: "Demo", jobId: 12, myobNumber: null, myobUrl: null,
      occurredAt: new Date("2026-10-13T01:00:00Z"), operation: "orders.create", proposalId: 5, proposedBy: "Ray", reason: `MYOB said no: /accountright/${OTHER}/Purchase is not this file`,
      rendered: { document: "Order", number: "66Sm261014" }, reviewedBy: "Johanne", ruleApplied: null,
    }],
  }), OPTIONS)!;
  expect(email.body).not.toContain(OTHER);
  expect(email.body).toContain("a company file Floorplan isn't set up for");
});

it("E: after a three-week gap the email says it couldn't be sent since then, covers the last 14 days, and points to the MYOB log", () => {
  const now = new Date("2026-10-13T22:00:30Z"); // Wed 14/10 07:30 Darwin
  const window = dailyWindow(now, {}, new Date("2026-09-22T22:00:00Z"));
  expect((window.until.getTime() - window.since.getTime()) / 86_400_000).toBe(14);
  expect(window.gapSince).toEqual(new Date("2026-09-22T22:00:00Z")); // 23/09 07:30 Darwin
  const email = buildMyobDailyEmail(facts({
    calls: [{ ...call, actorKind: "system", actorName: "t", errorMessage: null, httpStatus: 200, path: `/accountright/${CF}/Purchase/Order/Service/x`, phase: "response", purpose: "x" }],
    gapSince: window.gapSince, since: window.since, until: window.until,
  }), { ...OPTIONS, baseUrl: "https://floorplan.example" })!;
  expect(email.body).toContain("This email could not be sent since 23/09 07:30. This one covers the last 14 days; earlier activity is in the MYOB log: https://floorplan.example/admin/myob");
  const usual = dailyWindow(now, {}, new Date("2026-10-12T22:01:00Z"));
  expect(usual.gapSince).toBeNull();
  expect(buildMyobDailyEmail(facts({ calls: email ? [{ ...call, errorMessage: "x", path: "/accountright/", purpose: "y" }] : [] }), OPTIONS)!.body).not.toMatch(/could not be sent since/);
});
