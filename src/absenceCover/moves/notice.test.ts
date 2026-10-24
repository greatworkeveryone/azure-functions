/// <reference types="jest" />
import { EscalationError } from "../../escalation/errors";
import { raiseCoverNotice } from "./notice";

jest.mock("../../escalation/engine", () => ({ raiseWithin: jest.fn() }));
const engine = jest.requireMock("../../escalation/engine") as { raiseWithin: jest.Mock };
const conn = {} as never;

describe("raiseCoverNotice", () => {
  beforeEach(() => engine.raiseWithin.mockReset());

  it("raises the cover.moved notice about the ledger row, to the cover alone, on the caller's own transaction", async () => {
    const announce = jest.fn(async () => ({}));
    engine.raiseWithin.mockResolvedValue({ announce, created: true, escalation: {} });
    const send = await raiseCoverNotice(conn, { coverActionId: 901, deepLink: "/jobs?jobId=12", toUserId: 2 });
    expect(engine.raiseWithin).toHaveBeenCalledWith(conn, {
      actor: { kind: "system", name: "Floorplan (cover while away)" },
      context: { deepLink: "/jobs?jobId=12" },
      policyKey: "cover.moved",
      skipConditionCheck: true,
      subjectId: "901",
      subjectType: "absence_cover",
      userTargets: [2],
    });
    expect(announce).not.toHaveBeenCalled();
    await send();
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("sends no notice, and does not fail the move, when an admin has switched the policy off", async () => {
    engine.raiseWithin.mockRejectedValue(new EscalationError("policy_inactive", "off"));
    const send = await raiseCoverNotice(conn, { coverActionId: 901, deepLink: "/x", toUserId: 2 });
    await expect(send()).resolves.toBeUndefined();
  });

  it.each([new EscalationError("unknown_policy", "no such policy"), new Error("SQL down")])("fails the move for any other error: %s", async (error) => {
    engine.raiseWithin.mockRejectedValue(error);
    await expect(raiseCoverNotice(conn, { coverActionId: 901, deepLink: "/x", toUserId: 2 })).rejects.toBe(error);
  });
});
