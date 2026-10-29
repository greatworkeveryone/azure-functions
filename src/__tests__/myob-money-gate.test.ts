/// <reference types="jest" />
// The MYOB write/config routes return the money gate's refusal and do nothing
// else when it refuses (S11). Wrong roles are refused before the gate is asked.

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("token"),
  rolesForRequest: jest.fn().mockResolvedValue(["cfo"]),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "j@example.com", name: "Johanne", oid: "oid-j" }),
}));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Johanne", role: "cfo", userId: 12 }) }));
jest.mock("../moneyGate", () => ({ requireMoneyContext: jest.fn() }));

import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { acceptMyobBaseline } from "../functions/acceptMyobBaseline";
import { approveAndSendToMyob } from "../functions/approveAndSendToMyob";
import { importMyobMappings } from "../functions/importMyobMappings";
import { proposeToMyob } from "../functions/proposeToMyob";
import { registerMyobCompanyFile } from "../functions/registerMyobCompanyFile";
import { setMyobControl } from "../functions/setMyobControl";
import { setMyobFileMode } from "../functions/setMyobFileMode";

const db = require("../db") as Record<string, jest.Mock>;
const auth = require("../auth") as Record<string, jest.Mock>;
const { requireMoneyContext } = require("../moneyGate") as { requireMoneyContext: jest.Mock };

const REFUSAL: HttpResponseInit = { jsonBody: { code: "step_up_required", error: "Confirm it's you" }, status: 428 };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const json = jest.fn();
const req = { json } as unknown as HttpRequest;

type Handler = (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;
const ROUTES: [string, Handler][] = [
  ["approveAndSendToMyob", approveAndSendToMyob],
  ["proposeToMyob", proposeToMyob],
  ["setMyobControl", setMyobControl],
  ["setMyobFileMode", setMyobFileMode],
  ["registerMyobCompanyFile", registerMyobCompanyFile],
  ["importMyobMappings", importMyobMappings],
  ["acceptMyobBaseline", acceptMyobBaseline],
];

beforeEach(() => {
  jest.clearAllMocks();
  auth.rolesForRequest.mockResolvedValue(["cfo"]);
  json.mockResolvedValue({});
  requireMoneyContext.mockResolvedValue(REFUSAL);
});

describe.each(ROUTES)("%s", (_name, handler) => {
  it("returns the money gate's refusal and touches neither the body nor the database", async () => {
    const res = await handler(req, ctx);

    expect(res).toBe(REFUSAL);
    expect(json).not.toHaveBeenCalled();
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("refuses a wrong role (403) without asking the gate", async () => {
    auth.rolesForRequest.mockResolvedValue(["user"]);

    const res = await handler(req, ctx);

    expect(res.status).toBe(403);
    expect(requireMoneyContext).not.toHaveBeenCalled();
  });
});
