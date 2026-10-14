/// <reference types="jest" />
// An email the AI couldn't read stays reachable: facilities_manager and above
// can un-flag it back into the Incoming inbox (DL-34, jobs-flow §0.3).
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn().mockResolvedValue({}), executeQuery: jest.fn() }));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "fm@rp", name: "Fay Manager", oid: "fm-oid" }),
}));

import { AppRole } from "../auth";
import { unflagEmail } from "./unflagEmail";

const db = jest.requireMock("../db") as { createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const auth = jest.requireMock("../auth") as { requireRole: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ headers: { get: () => null }, json: async () => body }) as unknown as HttpRequest;

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockResolvedValue([{ EmailID: 7 }]);
});

describe("unflagEmail", () => {
  it("is for facilities_manager and above (director and admin through the hierarchy)", async () => {
    await unflagEmail(post({ EmailID: 7 }), ctx);
    expect(auth.requireRole).toHaveBeenCalledWith(expect.anything(), [AppRole.FACILITIES_APPROVAL]);
  });

  it("refuses other roles before touching the database", async () => {
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    const res = await unflagEmail(post({ EmailID: 7 }), ctx);
    expect(res.status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("clears the flag on a flagged email only", async () => {
    const res = await unflagEmail(post({ EmailID: 7 }), ctx);
    expect(res.status).toBe(200);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE Emails SET AIFlaggedForReview = 0[\s\S]*WHERE EmailID = @Id AND AIFlaggedForReview = 1/);
    expect(params).toEqual([expect.objectContaining({ name: "Id", value: 7 })]);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("Fay Manager"));
  });

  it("answers 404 when there is no flagged email with that id", async () => {
    db.executeQuery.mockResolvedValue([]);
    expect((await unflagEmail(post({ EmailID: 8 }), ctx)).status).toBe(404);
  });

  it("answers 400 without a numeric EmailID", async () => {
    expect((await unflagEmail(post({ EmailID: "7" }), ctx)).status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});
