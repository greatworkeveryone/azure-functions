import { canEndorseProcedure } from "../procedureEndorsement";

describe("procedure endorsement policy", () => {
  it.each(["facilities_manager", "accounts_manager"])("allows %s for a shared team procedure", role => {
    expect(canEndorseProcedure([role], ["all"], "team")).toBe(true);
    expect(canEndorseProcedure([role], ["all"], "executive")).toBe(false);
  });
  it("keeps team boundaries and excludes admin and officers", () => {
    expect(canEndorseProcedure(["facilities_manager"], ["accounts"], "team")).toBe(false);
    expect(canEndorseProcedure(["accounts_manager"], ["facilities"], "team")).toBe(false);
    for (const role of ["admin", "facilities", "accounts"]) expect(canEndorseProcedure([role], ["all"], "team")).toBe(false);
  });
  it.each(["cfo", "director"])("allows %s for an executive procedure", role => expect(canEndorseProcedure([role], ["facilities"], "executive")).toBe(true));
});
