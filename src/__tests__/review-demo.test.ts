// The demo seeder must refuse every non-local or differently named target.
// Importing it must not open a connection or start seeding.
const { assertTarget } = require("../../scripts/seed-review-demo.cjs");

describe("local demo target guard", () => {
  it("accepts only the named local review database", () => {
    expect(() => assertTarget("localhost", "floorplan_review")).not.toThrow();
  });
  it.each([
    ["production.database.windows.net", "floorplan_review"],
    ["localhost", "Floorplan"],
    ["127.0.0.1", "floorplan_review"],
    [undefined, undefined],
  ])("refuses %s / %s", (server, database) => {
    expect(() => assertTarget(server, database)).toThrow("only supports localhost/floorplan_review");
  });
});

const { demoScenario } = require("../../scripts/seed-review-demo.cjs");
it("keeps residence scenarios residential and aligns contractor trades", () => {
  const first = demoScenario(0, 0, true);
  const second = demoScenario(1, 1, true);
  expect(first.title).toContain("Air-conditioning");
  expect(first.contractor).toContain("Mechanical");
  expect(second.title).toContain("Roof");
  expect(second.contractor).toContain("Roofing");
});
