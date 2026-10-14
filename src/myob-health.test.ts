/// <reference types="jest" />

jest.mock("./db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({ id: "conn" }),
}));
jest.mock("./sentry", () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock("./escalation", () => ({ raise: jest.fn().mockResolvedValue({ created: true }) }));

import { MYOB_HEALTH_SUBJECTS, raiseMyobHealth } from "./myob-health";

const db = require("./db") as Record<string, jest.Mock>;
const { raise } = require("./escalation") as { raise: jest.Mock };
const { Sentry } = require("./sentry") as { Sentry: { captureException: jest.Mock } };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("raiseMyobHealth", () => {
  it("raises system.health on the system subject, as the system, without a condition check", async () => {
    await raiseMyobHealth(MYOB_HEALTH_SUBJECTS.link, "MYOB was linked", { businessId: "cf" });

    expect(raise).toHaveBeenCalledWith(
      { id: "conn" },
      expect.objectContaining({
        actor: { kind: "system", name: "myob" },
        context: { businessId: "cf" },
        policyKey: "system.health",
        skipConditionCheck: true,
        subjectId: "myob_link",
        subjectType: "system",
        summary: "MYOB was linked",
      }),
    );
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("never throws: a failure is logged and sent to Sentry", async () => {
    raise.mockRejectedValueOnce(new Error("policy inactive"));

    await expect(raiseMyobHealth(MYOB_HEALTH_SUBJECTS.agreement, "x", {})).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalled();
  });
});
