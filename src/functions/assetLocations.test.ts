/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "c@rp.com", name: "Connor", oid: "oid-1" }),
  };
});

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return {
    ...actual,
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    closeConnection: jest.fn(),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    createRequestConnection: jest.fn().mockResolvedValue({}),
    executeQuery: jest.fn().mockResolvedValue([]),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  };
});

import { getLocations } from "./getLocations";
import { upsertLocation } from "./upsertLocation";

type Row = Record<string, unknown>;
type SqlCall = [unknown, string, Array<{ name: string; value: unknown }>?];

const db = require("../db") as {
  beginTransaction: jest.Mock;
  closeConnection: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const auth = require("../auth") as { errorResponse: jest.Mock };

const context = new InvocationContext();

function route(routes: Array<{ match: RegExp; rows?: Row[] | ((params: Row) => Row[]); throws?: Error }>): void {
  db.executeQuery.mockImplementation(async (_connection: unknown, sql: string, params: Array<{ name: string; value: unknown }> = []) => {
    const hit = routes.find((r) => r.match.test(sql));
    if (!hit) return [];
    if (hit.throws) throw hit.throws;
    const byName = Object.fromEntries(params.map((p) => [p.name, p.value]));
    return typeof hit.rows === "function" ? hit.rows(byName) : (hit.rows ?? []);
  });
}
const queries = (match: RegExp): SqlCall[] =>
  (db.executeQuery.mock.calls as SqlCall[]).filter(([, sql]) => match.test(sql));
const paramsOf = (call: SqlCall): Row => Object.fromEntries((call[2] ?? []).map((p) => [p.name, p.value]));

const body = (value: unknown, query = ""): HttpRequest =>
  ({ json: async () => value, query: new URLSearchParams(query) }) as unknown as HttpRequest;
const notJson = (): HttpRequest =>
  ({ json: async () => { throw new SyntaxError("Unexpected token"); }, query: new URLSearchParams() }) as unknown as HttpRequest;

const loc = (overrides: Row = {}): Row => ({
  Active: true,
  BuildingId: 1,
  Kind: "level",
  LocationId: 2,
  Name: "Level 3",
  ParentLocationId: null,
  SortOrder: 3,
  SpaceType: null,
  ...overrides,
});

const BUILDING = /FROM dbo\.Buildings WHERE BuildingID/;
const LOCATION = /FROM dbo\.Locations l (?:WITH \(UPDLOCK, ROWLOCK\) )?WHERE l\.LocationId = @LocationId/;
const CYCLE = /WITH Ancestors AS \(\s+SELECT p\.LocationId/;
const USAGE = /AS ChildCount/;
const INSERT = /INSERT INTO dbo\.Locations/;
const UPDATE = /UPDATE dbo\.Locations/;

/** Serves locations by id from `byId` for every lookup of the location table. */
const locationsById = (byId: Record<number, Row>) => ({
  match: LOCATION,
  rows: (params: Row) => (byId[params.LocationId as number] ? [byId[params.LocationId as number]] : []),
});

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset();
  db.executeQuery.mockResolvedValue([]);
  db.createRequestConnection.mockResolvedValue({});
});

describe("getLocations", () => {
  it("rejects a non-numeric buildingId", async () => {
    const response = await getLocations(body({}, "buildingId=abc"), context);
    expect(response.status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("returns active locations for a building as camelCase, levels first", async () => {
    route([{ match: /FROM dbo\.Locations l/, rows: [loc(), loc({ Kind: "space", LocationId: 5, Name: "Plant room", ParentLocationId: 2, SpaceType: "plant" })] }]);
    const response = await getLocations(body({}, "buildingId=-3"), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      count: 2,
      locations: [
        { active: true, buildingId: 1, kind: "level", locationId: 2, name: "Level 3", parentLocationId: null, sortOrder: 3, spaceType: null },
        { active: true, buildingId: 1, kind: "space", locationId: 5, name: "Plant room", parentLocationId: 2, sortOrder: 3, spaceType: "plant" },
      ],
      truncated: false,
    });
    const [call] = queries(/FROM dbo\.Locations l/);
    expect(call[1]).toContain("l.Active = 1");
    expect(call[1]).toContain("l.BuildingId = @BuildingId");
    expect(call[1]).toMatch(/ORDER BY l\.BuildingId, CASE l\.Kind WHEN 'level' THEN 0 ELSE 1 END, l\.SortOrder/);
    expect(paramsOf(call)).toEqual({ BuildingId: -3 });
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });

  it("lists every building when none is given, behind the row ceiling", async () => {
    await getLocations(body({}), context);
    const [call] = queries(/FROM dbo\.Locations l/);
    expect(call[1]).toContain("TOP 5000");
    expect(call[1]).not.toContain("@BuildingId");
  });

  it("flags truncation at the ceiling", async () => {
    route([{ match: /FROM dbo\.Locations l/, rows: Array.from({ length: 5000 }, (_, i) => loc({ LocationId: i + 1 })) }]);
    const response = await getLocations(body({}), context);
    expect((response.jsonBody as { truncated: boolean }).truncated).toBe(true);
  });

  it("turns a database failure into a 500 and still closes the connection", async () => {
    route([{ match: /FROM dbo\.Locations l/, throws: new Error("boom") }]);
    const response = await getLocations(body({}), context);
    expect(response.status).toBe(500);
    expect(auth.errorResponse).toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});

describe("upsertLocation: validation before the database", () => {
  it("rejects a body that is not a JSON object", async () => {
    const response = await upsertLocation(notJson(), context);
    expect(response.status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([
    [{ buildingId: 1, kind: "floor", name: "X" }, "kind must be one of"],
    [{ kind: "level", name: "X" }, "buildingId is required"],
    [{ buildingId: 1, kind: "level" }, "name is required"],
    [{ buildingId: 1, kind: "level", name: "X", parentLocationId: 4 }, "cannot have a parent"],
    [{ buildingId: 1, kind: "level", name: "X", spaceType: "plant" }, "only applies to spaces"],
  ])("rejects %j", async (payload, message) => {
    const response = await upsertLocation(body(payload), context);
    expect(response.status).toBe(400);
    expect((response.jsonBody as { error: string }).error).toContain(message);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("upsertLocation: create", () => {
  it("creates a level, appending it after its siblings, in one transaction", async () => {
    route([
      { match: BUILDING, rows: [{ BuildingID: 1 }] },
      { match: INSERT, rows: [{ LocationId: 20 }] },
      locationsById({ 20: loc({ LocationId: 20, Name: "Level 9", SortOrder: 9 }) }),
    ]);
    const response = await upsertLocation(body({ buildingId: 1, kind: "level", name: " Level 9 " }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ created: true, location: { locationId: 20, name: "Level 9", kind: "level" } });
    const [insert] = queries(INSERT);
    expect(paramsOf(insert)).toMatchObject({
      BuildingId: 1,
      Caller: "Connor",
      Kind: "level",
      Name: "Level 9",
      ParentLocationId: null,
      SortOrder: null,
      SpaceType: null,
    });
    expect(insert[1]).toContain("ISNULL(@SortOrder");
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("types a space 'other' unless told otherwise and honours an explicit sortOrder", async () => {
    route([
      { match: BUILDING, rows: [{ BuildingID: 1 }] },
      locationsById({
        2: loc(),
        21: loc({ Kind: "space", LocationId: 21, Name: "Store", ParentLocationId: 2, SortOrder: 4, SpaceType: "other" }),
      }),
      { match: INSERT, rows: [{ LocationId: 21 }] },
    ]);
    const response = await upsertLocation(body({ buildingId: 1, kind: "space", name: "Store", parentLocationId: 2, sortOrder: 4 }), context);
    expect(response.status).toBe(200);
    expect(paramsOf(queries(INSERT)[0])).toMatchObject({ Kind: "space", ParentLocationId: 2, SortOrder: 4, SpaceType: "other" });
  });

  it("rejects an unknown building and rolls back", async () => {
    const response = await upsertLocation(body({ buildingId: 99, kind: "level", name: "X" }), context);
    expect(response.status).toBe(400);
    expect((response.jsonBody as { error: string }).error).toBe("Unknown building");
    expect(queries(INSERT)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("rejects a parent from a different building", async () => {
    route([{ match: BUILDING, rows: [{ BuildingID: 1 }] }, locationsById({ 7: loc({ BuildingId: 2, LocationId: 7 }) })]);
    const response = await upsertLocation(body({ buildingId: 1, kind: "space", name: "Store", parentLocationId: 7 }), context);
    expect(response.status).toBe(400);
    expect((response.jsonBody as { error: string }).error).toContain("different building");
    expect(queries(INSERT)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown or inactive parent", async () => {
    route([{ match: BUILDING, rows: [{ BuildingID: 1 }] }, locationsById({ 8: loc({ Active: false, LocationId: 8 }) })]);
    const unknown = await upsertLocation(body({ buildingId: 1, kind: "space", name: "A", parentLocationId: 99 }), context);
    expect((unknown.jsonBody as { error: string }).error).toBe("Unknown parent location");
    const inactive = await upsertLocation(body({ buildingId: 1, kind: "space", name: "A", parentLocationId: 8 }), context);
    expect((inactive.jsonBody as { error: string }).error).toBe("Parent location is inactive");
  });

  it("answers 409 when an active sibling already has the name", async () => {
    route([
      { match: BUILDING, rows: [{ BuildingID: 1 }] },
      {
        match: INSERT,
        throws: Object.assign(new Error("Cannot insert duplicate key row in object 'dbo.Locations' with unique index 'UX_Locations_Root_Name'."), { number: 2601 }),
      },
    ]);
    const response = await upsertLocation(body({ buildingId: 1, kind: "level", name: "Level 3" }), context);
    expect(response.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});

describe("upsertLocation: update", () => {
  it("404s for a location that does not exist", async () => {
    const response = await upsertLocation(body({ locationId: 99, name: "X" }), context);
    expect(response.status).toBe(404);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("renames in place, stamping the editor", async () => {
    route([locationsById({ 2: loc() })]);
    const response = await upsertLocation(body({ locationId: 2, name: "Level Three" }), context);

    expect(response.status).toBe(200);
    expect((response.jsonBody as { created: boolean }).created).toBe(false);
    const [update] = queries(UPDATE);
    expect(update[1]).toContain("Name = @Name");
    expect(update[1]).toContain("UpdatedBy = @UpdatedBy");
    expect(paramsOf(update)).toMatchObject({ LocationId: 2, Name: "Level Three", UpdatedBy: "Connor" });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("never moves a location between buildings or changes its kind", async () => {
    route([locationsById({ 2: loc() })]);
    const moved = await upsertLocation(body({ buildingId: 5, locationId: 2, name: "X" }), context);
    expect((moved.jsonBody as { error: string }).error).toContain("different building");
    const retyped = await upsertLocation(body({ kind: "space", locationId: 2, name: "X" }), context);
    expect((retyped.jsonBody as { error: string }).error).toContain("kind cannot be changed");
    expect(queries(UPDATE)).toHaveLength(0);
  });

  it("keeps levels top-level and untyped", async () => {
    route([locationsById({ 2: loc(), 3: loc({ LocationId: 3 }) })]);
    const parented = await upsertLocation(body({ locationId: 2, parentLocationId: 3 }), context);
    expect((parented.jsonBody as { error: string }).error).toContain("cannot have a parent");
    const typed = await upsertLocation(body({ locationId: 2, spaceType: "plant" }), context);
    expect((typed.jsonBody as { error: string }).error).toContain("only applies to spaces");
  });

  it("refuses to make a location its own parent or ancestor", async () => {
    const space = loc({ Kind: "space", LocationId: 5, Name: "Plant", ParentLocationId: 2, SpaceType: "plant" });
    const child = loc({ Kind: "space", LocationId: 6, Name: "Cupboard", ParentLocationId: 5, SpaceType: "other" });
    route([locationsById({ 2: loc(), 5: space, 6: child }), { match: CYCLE, rows: [{ LocationId: 5 }] }]);

    const self = await upsertLocation(body({ locationId: 5, parentLocationId: 5 }), context);
    expect((self.jsonBody as { error: string }).error).toContain("its own parent");

    const loop = await upsertLocation(body({ locationId: 5, parentLocationId: 6 }), context);
    expect(loop.status).toBe(400);
    expect((loop.jsonBody as { error: string }).error).toContain("its own ancestor");
    expect(queries(UPDATE)).toHaveLength(0);
  });

  it("moves a space to a new parent in the same building", async () => {
    const space = loc({ Kind: "space", LocationId: 5, Name: "Plant", ParentLocationId: 2, SpaceType: "plant" });
    route([locationsById({ 2: loc(), 3: loc({ LocationId: 3, Name: "Level 4" }), 5: space }), { match: CYCLE, rows: [] }]);
    const response = await upsertLocation(body({ locationId: 5, parentLocationId: 3 }), context);
    expect(response.status).toBe(200);
    expect(paramsOf(queries(UPDATE)[0])).toMatchObject({ LocationId: 5, ParentLocationId: 3 });
  });

  it("can lift a space to the building root", async () => {
    const space = loc({ Kind: "space", LocationId: 5, Name: "Plant", ParentLocationId: 2, SpaceType: "plant" });
    route([locationsById({ 5: space })]);
    await upsertLocation(body({ locationId: 5, parentLocationId: null }), context);
    expect(paramsOf(queries(UPDATE)[0])).toMatchObject({ ParentLocationId: null });
  });

  it("resets a cleared space type to 'other'", async () => {
    const space = loc({ Kind: "space", LocationId: 5, Name: "Plant", ParentLocationId: 2, SpaceType: "plant" });
    route([locationsById({ 5: space })]);
    await upsertLocation(body({ locationId: 5, spaceType: null }), context);
    expect(paramsOf(queries(UPDATE)[0])).toMatchObject({ SpaceType: "other" });
  });

  it("will not deactivate a location that still holds assets or active sub-locations", async () => {
    route([locationsById({ 2: loc() }), { match: USAGE, rows: [{ AssetCount: 3, ChildCount: 1 }] }]);
    const response = await upsertLocation(body({ active: false, locationId: 2 }), context);
    expect(response.status).toBe(409);
    expect((response.jsonBody as { error: string }).error).toContain("3 asset(s)");
    expect((response.jsonBody as { error: string }).error).toContain("1 active sub-location(s)");
    expect(queries(UPDATE)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("deactivates an empty location", async () => {
    route([locationsById({ 2: loc() }), { match: USAGE, rows: [{ AssetCount: 0, ChildCount: 0 }] }]);
    const response = await upsertLocation(body({ active: false, locationId: 2 }), context);
    expect(response.status).toBe(200);
    expect(paramsOf(queries(UPDATE)[0])).toMatchObject({ Active: false });
  });

  it("does not re-run the usage check for an already inactive location", async () => {
    route([locationsById({ 2: loc({ Active: false }) })]);
    await upsertLocation(body({ active: false, locationId: 2, sortOrder: 1 }), context);
    expect(queries(USAGE)).toHaveLength(0);
  });

  it("rejects an update that changes nothing", async () => {
    route([locationsById({ 2: loc() })]);
    const response = await upsertLocation(body({ locationId: 2 }), context);
    expect(response.status).toBe(400);
    expect((response.jsonBody as { error: string }).error).toBe("No fields to update");
  });

  it("answers 409 when a rename collides with an active sibling", async () => {
    route([
      locationsById({ 2: loc() }),
      { match: UPDATE, throws: Object.assign(new Error("Cannot insert duplicate key row in object 'dbo.Locations' with unique index 'UX_Locations_Root_Name'."), { number: 2601 }) },
    ]);
    const response = await upsertLocation(body({ locationId: 2, name: "Ground" }), context);
    expect(response.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("rolls back and reports an unexpected failure", async () => {
    route([locationsById({ 2: loc() }), { match: UPDATE, throws: new Error("deadlock victim") }]);
    const response = await upsertLocation(body({ locationId: 2, name: "X" }), context);
    expect(response.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});
