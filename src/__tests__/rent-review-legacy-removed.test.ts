/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// WP25 replaced the review machinery. Three things must stay true: the apply
// endpoint that wrote a review's result by hand is gone (D1: reviews resolve
// schedule steps, WP26's APPLY writes them), the old timer's inserts that always
// failed the legacy ReviewType check are gone, and nothing the workflow adds
// can hard-delete a review (database-safety rules).

const ROOT = join(__dirname, "..", "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("applyRentReview is gone", () => {
  const files = sourceFiles(join(ROOT, "src"));

  it("is registered nowhere and referenced nowhere in the backend", () => {
    for (const file of files) {
      expect(readFileSync(file, "utf8")).not.toMatch(/applyRentReview/);
    }
  });

  it("is not in the API description either", () => {
    expect(read("src/openapi.json")).not.toMatch(/applyRentReview/);
  });

  it("leaves the rest of the review reads and the register in place", () => {
    const tenancy = read("src/functions/tenancy.ts");
    expect(tenancy).toMatch(/app\.http\("getReviewsDue"/);
    expect(tenancy).toMatch(/app\.http\("getRegisterTenant"/);
  });
});

describe("the review endpoints are registered", () => {
  it.each([
    "getRentReviews",
    "getRentReview",
    "commenceRentReview",
    "updateRentReviewBasis",
    "getUpcomingLeaseEvents",
    // WP26
    "calculateRentReview",
    "submitRentReview",
    "approveRentReview",
    "returnRentReview",
    "waiveRentReview",
    "cancelRentReview",
    "revertRentReview",
  ])(
    "%s, one function in one file",
    (name) => {
      const source = read(`src/functions/${name}.ts`);
      expect(source.match(/app\.http\(/g)).toHaveLength(1);
      expect(source).toMatch(new RegExp(`app\\.http\\("${name}"`));
      expect(source).toMatch(/requireRole\(/);
    },
  );
});

describe("the old generator is gone", () => {
  const timer = read("src/functions/tenancyReviewScheduleTimer.ts");

  it("no longer inserts the tenancy's free-form review type, or rewrites a tenancy", () => {
    expect(timer).not.toMatch(/INSERT INTO/i);
    expect(timer).not.toMatch(/UPDATE dbo\./i);
    expect(timer).not.toMatch(/NextReviewDate = DATEADD/);
  });

  it("is registered once, daily, and is opt-in", () => {
    expect(timer.match(/app\.timer\(/g)).toHaveLength(1);
    expect(timer).toMatch(/app\.timer\("tenancyReviewScheduleTimer"/);
    expect(timer).toMatch(/RENT_REVIEW_GENERATOR_ENABLED/);
    expect(timer).toMatch(/RENT_REVIEW_GENERATOR_DRY_RUN/);
  });
});

describe("nothing the workflow adds can delete a review", () => {
  const added = [
    ...sourceFiles(join(ROOT, "src", "rentReview")),
    join(ROOT, "src", "rentReviewMachine.ts"),
    join(ROOT, "src", "leaseMethod.ts"),
    join(ROOT, "src", "leaseOptions.ts"),
    join(ROOT, "src", "escalation", "adapters", "tenancy.ts"),
    // WP26
    join(ROOT, "src", "rentReviewCalc.ts"),
    join(ROOT, "src", "rentScheduleChangeLog.ts"),
    join(ROOT, "src", "escalation", "adapters", "rentReview.ts"),
    ...[
      "getRentReviews",
      "getRentReview",
      "commenceRentReview",
      "updateRentReviewBasis",
      "getUpcomingLeaseEvents",
      "tenancyReviewScheduleTimer",
      "calculateRentReview",
      "submitRentReview",
      "approveRentReview",
      "returnRentReview",
      "waiveRentReview",
      "cancelRentReview",
      "revertRentReview",
    ].map((name) => join(ROOT, "src", "functions", `${name}.ts`)),
  ];

  it.each(added.map((file) => relative(ROOT, file)))("%s has no hard delete, comments included", (file) => {
    const text = readFileSync(join(ROOT, file), "utf8");
    expect(text).not.toMatch(/DELETE\s+FROM/i);
    expect(text).not.toMatch(/deleteBlob\(/);
    expect(text).not.toMatch(/\bTRUNCATE\b|\bDROP\s+(TABLE|COLUMN)\b/i);
  });
});
