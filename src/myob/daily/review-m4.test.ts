/// <reference types="jest" />

// The M4 reviewer's scenarios (17 Oct), kept in the suite, now asserting the fix:
//   A  something due and no CFO has an address: the run fails (the timer throws), not "ok"
//   B  a send Floorplan held back reads "approved", never "approved and sent"
//   C  a call under another API base that names an unregistered file is not in the email

jest.mock("../../graph", () => ({ graphSendMail: jest.fn() }));

import { buildMyobDailyEmail } from "./email";
import { runMyobDaily } from "./run";
import type { DailyFacts } from "./types";

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const API_BASE = "https://api.myob.com/accountright";
const facts = (over: Partial<DailyFacts> = {}): DailyFacts => ({
  calls: [], controls: [], events: [], files: [{ id: CF, name: "Demo Pty Ltd" }],
  since: new Date("2026-10-12T22:00:00Z"), until: new Date("2026-10-13T22:00:00Z"), ...over,
});
const event = {
  action: "myob.approve", actorName: "Johanne", after: null, companyFileId: CF, companyFileName: "Demo", jobId: 12, myobNumber: null, myobUrl: null,
  occurredAt: new Date("2026-10-13T01:00:00Z"), operation: "orders.create", proposalId: 5, proposedBy: "Ray", reason: null,
  rendered: { document: "Order", number: "66Sm261014" }, reviewedBy: "Johanne", ruleApplied: null,
};

it("A: something due, every CFO without an address: nothing sent, and an error the timer fails on", async () => {
  const env = { APP_BASE_URL: "https://fp.test", GRAPH_CLIENT_ID: "x", GRAPH_CLIENT_SECRET: "x", GRAPH_TENANT_ID: "x", GRAPH_SENDER_EMAIL: "a@b.test" } as NodeJS.ProcessEnv;
  const send = jest.fn();
  const report = await runMyobDaily({} as never, { dryRun: false, env, log: () => undefined, now: new Date("2026-10-13T22:00:30Z") }, {
    lastCovered: async () => null, load: async () => facts({ events: [event] }), recipients: async () => [{ email: null, name: "Johanne", userId: 12 }], send,
  });
  expect(send).not.toHaveBeenCalled();
  expect(report).toMatchObject({ noAddress: 1, nothingToSend: false, sent: 0 });
  expect(report.errors).toEqual([expect.stringContaining("nobody was sent")]);
  expect(report.configMissing.length > 0 || (report.errors.length > 0 && report.sent + report.wouldSend === 0)).toBe(true);
});

it("B: a held-back send reads as 'approved', and the refusal stays in the calls", () => {
  const email = buildMyobDailyEmail(facts({
    calls: [{ actorKind: "user", actorName: "Johanne", errorMessage: "Dry run (CFO control): orders.create was not sent to MYOB", httpStatus: null,
      method: "POST", occurredAt: new Date("2026-10-13T01:00:01Z"), path: `/accountright/${CF}/Purchase/Order/Service`, phase: "error", purpose: "create-order" }],
    events: [event],
  }), { apiBase: API_BASE, baseUrl: null, firstName: "Johanne", overriddenFrom: null });
  expect(email?.body).not.toContain("approved and sent");
  expect(email?.body).toContain("· Johanne · approved · Order 66Sm261014");
  expect(email?.body).toContain("refused or failed: Dry run (CFO control)");
});

it("C: a call under another API base naming an unregistered file is never listed", () => {
  const call = { actorKind: "system", actorName: "t", errorMessage: null, httpStatus: 200, method: "GET", occurredAt: new Date("2026-10-13T01:00:00Z"), phase: "response" as const, purpose: "list" };
  expect(buildMyobDailyEmail(facts({ calls: [{ ...call, path: `/myob-mock/${OTHER}/Purchase/Order` }] }), { apiBase: API_BASE, baseUrl: null, firstName: "J", overriddenFrom: null })).toBeNull();
  // Under the configured base, the classifier finds the file: registered, it is listed; not, it isn't.
  const mock = "http://localhost:9000/myob-mock";
  expect(buildMyobDailyEmail(facts({ calls: [{ ...call, path: `/myob-mock/${OTHER}/Purchase/Order` }] }), { apiBase: mock, baseUrl: null, firstName: "J", overriddenFrom: null })).toBeNull();
  const listed = buildMyobDailyEmail(facts({ calls: [{ ...call, path: `/myob-mock/${CF}/Purchase/Order` }] }), { apiBase: mock, baseUrl: null, firstName: "J", overriddenFrom: null });
  expect(listed?.body).toContain("MYOB calls (1)");
});
