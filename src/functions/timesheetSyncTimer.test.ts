/// <reference types="jest" />
import { InvocationContext, Timer } from "@azure/functions";

jest.mock("@azure/functions", () => ({ app: { timer: jest.fn() } }));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([{ TimesheetID: 1 }, { TimesheetID: 2 }]),
}));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), flush: jest.fn().mockResolvedValue(true) } }));

import { executeQuery } from "../db";
import { timesheetSyncTimer } from "./timesheetSyncTimer";

const ctx = { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext;

describe("timesheetSyncTimer", () => {
  it("reports the backlog but never stamps SentToMyobDate while sending is not built", async () => {
    await timesheetSyncTimer({} as Timer, ctx);

    const sqls = (executeQuery as jest.Mock).mock.calls.map((c) => String(c[1]));
    expect(sqls.some((sql) => /UPDATE/i.test(sql))).toBe(false);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("2 approved timesheets awaiting MYOB sync"));
  });
});
