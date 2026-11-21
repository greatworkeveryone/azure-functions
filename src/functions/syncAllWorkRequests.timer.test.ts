/// <reference types="jest" />
// SECS-08: the nightly myBuildings mirror refresh has an off switch, and the pager has a page cap.
jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn().mockResolvedValue({}), executeQuery: jest.fn().mockResolvedValue([]) }));
jest.mock("../mybuildings-client", () => ({ fetchWorkRequests: jest.fn().mockResolvedValue([]) }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), flush: jest.fn().mockResolvedValue(true) } }));

import type { InvocationContext, Timer } from "@azure/functions";
import { syncAllWorkRequestsTimer } from "./syncAllWorkRequests";

const db = require("../db") as { createRequestConnection: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const saved = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...saved, MYBUILDINGS_BEARER_TOKEN: "t" };
  delete process.env.MYBUILDINGS_SYNC_ENABLED;
});
afterAll(() => {
  process.env = saved;
});

describe("syncAllWorkRequestsTimer", () => {
  it("does nothing, and opens no connection, when MYBUILDINGS_SYNC_ENABLED is false", async () => {
    process.env.MYBUILDINGS_SYNC_ENABLED = "false";
    await syncAllWorkRequestsTimer({} as Timer, ctx);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("still runs when the flag is unset or anything but false", async () => {
    await syncAllWorkRequestsTimer({} as Timer, ctx);
    process.env.MYBUILDINGS_SYNC_ENABLED = "true";
    await syncAllWorkRequestsTimer({} as Timer, ctx);
    expect(db.createRequestConnection).toHaveBeenCalledTimes(2);
  });
});
