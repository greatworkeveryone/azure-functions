import { parseAudienceRequest } from "./audienceInput";

const parse = (body: unknown) => parseAudienceRequest(body as Record<string, unknown>);
const error = (body: unknown): string => {
  const result = parse(body);
  return result.ok ? "" : result.error;
};

describe("parseAudienceRequest", () => {
  it("reads a tenancy choice, defaulting to both contacts and commercial buildings only", () => {
    const result = parse({ tenancies: { selections: [{ buildingId: 5, levels: ["Level 2", "Level 3"] }] } });
    expect(result).toEqual({
      ok: true,
      value: { contractors: null, staff: null, tenancies: { categories: ["commercial"], contacts: ["primary", "accounts"], selections: [{ buildingId: 5, levels: ["Level 2", "Level 3"] }] }, typed: [] },
    });
  });

  it("treats no levels as the whole building, and the whole building as winning over levels named for it", () => {
    const result = parse({ tenancies: { selections: [{ buildingId: 5, levels: ["Level 2"] }, { buildingId: 5 }, { buildingId: 5, levels: ["Level 3"] }, { buildingId: 6, levels: ["G"] }, { buildingId: 6, levels: ["G", "1"] }] } });
    expect(result.ok && result.value.tenancies?.selections).toEqual([{ buildingId: 5, levels: [] }, { buildingId: 6, levels: ["G", "1"] }]);
  });

  it("reads contractors by trade, by building or both, staff by role and typed addresses", () => {
    const result = parse({ contractors: { buildingIds: [5], trades: ["Electrical"] }, staff: { roles: ["facilities"] }, typed: [" a@x.com ", "a@x.com", "b@y.com"] });
    expect(result).toMatchObject({ ok: true, value: { contractors: { buildingIds: [5], trades: ["Electrical"] }, staff: { roles: ["facilities"] }, typed: ["a@x.com", "b@y.com"] } });
  });

  it.each([
    [{}, "Choose who the email is for"],
    [{ typed: [] }, "Choose who the email is for"],
    [{ tenancies: { selections: [] } }, "Choose at least one building"],
    [{ tenancies: { selections: [{ buildingId: "5" }] } }, "A building choice needs a building id"],
    [{ tenancies: { selections: [{ buildingId: -1 }] } }, "A building choice needs a building id"],
    [{ tenancies: { selections: [{ buildingId: 5 }], contacts: ["boss"] } }, "contacts must be one or more of"],
    [{ tenancies: { selections: [{ buildingId: 5 }], categories: [] } }, "categories must be one or more of"],
    [{ tenancies: { selections: [{ buildingId: 5 }], extra: 1 } }, 'Unknown field "extra"'],
    [{ contractors: {} }, "Choose a trade, a building or both for contractors"],
    [{ contractors: { trades: [""] } }, "Trades must be short text"],
    [{ contractors: { buildingIds: ["x"] } }, "buildingIds must be a list of building ids"],
    [{ staff: { roles: [] } }, "Choose at least one staff role"],
    [{ staff: { roles: ["user"] } }, '"user" is not a staff role'],
    [{ staff: { roles: ["janitor"] } }, '"janitor" is not a staff role'],
    [{ typed: "a@x.com" }, "Typed addresses must be a list"],
    [{ typed: ["x".repeat(400)] }, "Typed addresses must be short text"],
    [{ emails: ["a@x.com"] }, 'Unknown field "emails"'],
  ])("refuses %j", (body, expected) => {
    expect(error(body)).toContain(expected);
  });

  it("refuses more than 500 typed addresses", () => {
    expect(error({ typed: Array.from({ length: 501 }, (_, i) => `a${i}@x.com`) })).toContain("at most 500");
  });
});
