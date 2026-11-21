/// <reference types="jest" />
// SECF-03 / L1: an event carrying an email address leaves the Functions app without it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scrubBreadcrumb, scrubEvent } from "./sentryScrub";

const ADDRESS = "fay.staff@randazzo.example";

describe("scrubEvent", () => {
  it("removes the address and the person from an error event", () => {
    const out = scrubEvent({
      breadcrumbs: [{ data: { file: `from-${ADDRESS}.pdf` }, message: `fetched mail for ${ADDRESS}` }],
      exception: { values: [{ type: "Error", value: `Graph said: no mailbox ${ADDRESS}` }] },
      extra: { upstream: `{"to":"${ADDRESS}"}`, status: 404 },
      request: { cookies: { a: "b" }, data: { email: ADDRESS }, headers: { authorization: "Bearer x", "x-trace": ADDRESS }, url: `/api/x?e=${ADDRESS}` },
      user: { email: ADDRESS, id: "oid-1", username: "Fay Staff" },
    });

    const text = JSON.stringify(out);
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain("Fay Staff");
    expect(text).not.toContain("Bearer");
    expect(out.user).toEqual({ id: "oid-1" });
    expect((out.extra as { status: number }).status).toBe(404);
  });

  it("removes the address from a transaction's name and spans", () => {
    const out = scrubEvent({
      spans: [{ data: { "db.statement": `WHERE Email = '${ADDRESS}'` }, description: `lookup ${ADDRESS}`, span_id: "s", start_timestamp: 1, trace_id: "t" }],
      transaction: `POST /users/${ADDRESS}`,
      type: "transaction",
    });
    expect(JSON.stringify(out)).not.toContain(ADDRESS);
  });

  it("scrubs a single breadcrumb", () => {
    expect(JSON.stringify(scrubBreadcrumb({ message: ADDRESS }))).not.toContain(ADDRESS);
  });

  it("is wired into Sentry.init for errors, transactions and breadcrumbs", () => {
    const source = readFileSync(join(__dirname, "sentry.ts"), "utf8");
    expect(source).toMatch(/beforeSend:\s*scrubEvent/);
    expect(source).toMatch(/beforeSendTransaction:\s*scrubEvent/);
    expect(source).toMatch(/beforeBreadcrumb:\s*scrubBreadcrumb/);
  });
});
