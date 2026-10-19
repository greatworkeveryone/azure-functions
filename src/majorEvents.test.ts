import { canManageEvent, canReadEvent, parseEventInput, parseEventEntry } from "./majorEvents";
import { AppRole } from "./auth";
const input = { title: "Cyclone preparation", domain: "operational", eventType: "cyclone", ownerName: "FM", startsAt: "2026-10-19T08:00:00Z", endsAt: null, brief: "Secure the portfolio", plan: { buildingIds: [-7,33532], jobIds: [], actions: [{ id: "secure", title: "Secure roof access", owner: "Team A", due: null, done: false }] } };
describe("event authority", () => {
  test.each(Object.values(AppRole))("%s operational create/close is exact", role => expect(canManageEvent([role], "operational")).toBe(["facilities_manager","director"].includes(role)));
  test.each(Object.values(AppRole))("%s financial create/close/read is exact", role => {
    expect(canManageEvent([role], "financial")).toBe(["cfo","director"].includes(role));
    expect(canReadEvent([role], "financial")).toBe(["cfo","director"].includes(role));
  });
});
describe("event validation", () => {
  it("accepts manual buildings and explicit action ownership", () => expect(parseEventInput(input).plan.buildingIds).toEqual([-7,33532]));
  test.each([
    { title: "" }, { domain: "admin" }, { eventType: "unknown" }, { startsAt: "nonsense" }, { endsAt: "2026-10-18T08:00:00Z" },
    { plan: { ...input.plan, buildingIds: [] } }, { plan: { ...input.plan, buildingIds: [1.5] } }, { plan: { ...input.plan, jobIds: [-7] } },
    { plan: { ...input.plan, actions: [{ ...input.plan.actions[0], done: "yes" }] } },
    { plan: { ...input.plan, actions: [input.plan.actions[0], input.plan.actions[0]] } },
  ])("rejects invalid plan %j", patch => expect(() => parseEventInput({ ...input, ...patch })).toThrow());
  it("does not accept fake approval or forged audit entry types", () => expect(() => parseEventEntry({ type: "approved", body: "pay it" })).toThrow());
  it("supports building-specific updates", () => expect(parseEventEntry({ type: "update", body: "Power restored", buildingId: -7, area: "Ground" })).toMatchObject({ type: "update", buildingId: -7 }));
  it("requires broadcasts to remain outside this stage", () => expect(() => parseEventEntry({ type: "communication_draft", body: "Send notice" })).toThrow());
  it("lets creators select the audience independently of CFO authority", () => expect(parseEventInput({ ...input, domain: "financial", eventType: "cyber_incident", audience: "accounts_team" })).toMatchObject({ domain: "financial", audience: "accounts_team", eventType: "cyber_incident" }));
  it("limits Accounts-only events to their selected audience and management authority", () => {
    expect(canReadEvent([AppRole.ACCOUNTS], "financial", "accounts_team")).toBe(true);
    expect(canReadEvent([AppRole.FACILITIES], "financial", "accounts_team")).toBe(false);
    expect(canReadEvent([AppRole.ACCOUNTS], "financial", "accounts_managers")).toBe(false);
  });
});
