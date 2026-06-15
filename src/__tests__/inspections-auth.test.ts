/// <reference types="jest" />
import { HttpRequest } from "@azure/functions";
import { AppRole, clearRoleCache, requireRole } from "../auth";
import { EDIT_INSPECTIONS_ROLES } from "../functions/inspections";

// Mock the DB so the role lookup resolves from a stubbed AppUsers row.
jest.mock("../db", () => ({
  beginTransaction:        jest.fn(),
  closeConnection:         jest.fn(),
  commitTransaction:       jest.fn(),
  createConnection:        jest.fn(),
  createServiceConnection: jest.fn(),
  executeQuery:            jest.fn(),
  rollbackTransaction:     jest.fn(),
}));

const db = require("../db") as {
  closeConnection:         jest.Mock;
  createServiceConnection: jest.Mock;
  executeQuery:            jest.Mock;
};

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function makeRequest(headers: Record<string, string> = {}): HttpRequest {
  return {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
  } as unknown as HttpRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  clearRoleCache();
  db.createServiceConnection.mockResolvedValue({});
  db.closeConnection.mockImplementation(() => undefined);
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
});

// Facilities staff are the field inspectors. The frontend grants them the
// `editInspections` capability (constants/roles.ts) and the backend's
// deleteInspection lets them remove inspections they created — both only make
// sense if facilities can create/edit inspections in the first place. This
// guards the backend gate against drifting back to manager-only.
describe("inspection editing — facilities authorisation", () => {
  it("allows a plain FACILITIES user through the EDIT_INSPECTIONS_ROLES gate", async () => {
    db.executeQuery.mockResolvedValue([{ Role: "facilities" }]);
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "insp-facilities" })}`,
    });

    const denied = await requireRole(req, EDIT_INSPECTIONS_ROLES);

    expect(denied).toBeNull();
  });

  it("still denies a Pending (no-role) caller", async () => {
    db.executeQuery.mockResolvedValue([]);
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "insp-pending" })}`,
    });

    const denied = await requireRole(req, EDIT_INSPECTIONS_ROLES);

    expect(denied?.status).toBe(403);
  });
});
