jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../escalation/engine", () => ({ raiseWithin: jest.fn() }));
jest.mock("../escalation/adapters", () => ({}));
import { declineDirector, needsDeclineDirector, notifyProxyDecline } from "../directorDeclineAttribution";
import { executeQuery } from "../db";
import { raiseWithin } from "../escalation/engine";
const actor = { kind: "user" as const, role: "accounts", userId: 3, name: "Accounts" };
const query = executeQuery as jest.Mock;
beforeEach(() => jest.clearAllMocks());
it.each([undefined, null, -1, 0, "7", 1.5])("rejects invalid attributed director %p without SQL", async id => {
  expect(await declineDirector({} as never, actor, true, id)).toBeNull();
  expect(query).not.toHaveBeenCalled();
});
it("requires a named director only for staff declining the director stage", () => {
  expect(needsDeclineDirector(actor, true)).toBe(true);
  expect(needsDeclineDirector(actor, false)).toBe(false);
  expect(needsDeclineDirector({ ...actor, role: "director" }, true)).toBe(false);
});
it("loads only an active director, never a client-supplied name or other role", async () => {
  query.mockResolvedValue([{ UserID: 7, DisplayName: "Director" }]);
  expect(await declineDirector({} as never, actor, true, 7)).toEqual({ userId: 7, name: "Director", role: "director" });
  expect(query.mock.calls[0][1]).toContain("IsActive=1 AND Role='director'");
  query.mockResolvedValue([]);
  expect(await declineDirector({} as never, actor, true, 7)).toBeNull();
});
it("records a durable director inbox notice with both people and the subject", async () => {
  await notifyProxyDecline({} as never, { actor, director: { userId: 7, role: "director", name: "Director" }, kind: "invoice", id: 21, jobId: 5, reason: "Wrong scope" });
  expect(raiseWithin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ policyKey: "job.director_proxy_decline", subjectId: "invoice:21@5", summary: expect.stringContaining("Accounts recorded a verbal decline by Director"), note: "Wrong scope" }));
});
