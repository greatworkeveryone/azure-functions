/// <reference types="jest" />
import { TYPES } from "tedious";
import { buildDecisionWhere, escapeLike, parseDecisionFilters } from "./filters";
import type { DecisionFilters } from "./filters";

function parse(query: string) {
  return parseDecisionFilters(new URLSearchParams(query));
}

function ok(query: string): DecisionFilters {
  const result = parse(query);
  if (!result.ok) throw new Error(`expected ${query} to parse, got: ${result.error}`);
  return result.filters;
}

function error(query: string): string {
  const result = parse(query);
  if (result.ok) throw new Error(`expected ${query} to be refused`);
  return result.error;
}

describe("parseDecisionFilters", () => {
  it("defaults to everything, newest first, as JSON", () => {
    expect(ok("")).toEqual({ exceptionsOnly: false, format: "json", sort: "occurredAt" });
  });

  it("reads from and to as whole Darwin days, both ends inclusive", () => {
    const f = ok("from=2026-10-01&to=2026-10-13");
    expect(f.from?.toISOString()).toBe("2026-09-30T14:30:00.000Z");
    // Exclusive bound: the first instant of the 14th in Darwin.
    expect(f.toExclusive?.toISOString()).toBe("2026-10-13T14:30:00.000Z");
  });

  it("accepts a single-day range", () => {
    const f = ok("from=2026-10-13&to=2026-10-13");
    expect(f.toExclusive!.getTime() - f.from!.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("refuses a bad or month-first date", () => {
    expect(error("from=10/13/2026")).toMatch(/from must be a date as YYYY-MM-DD/);
    expect(error("to=13/10/2026")).toMatch(/to must be a date as YYYY-MM-DD/);
    expect(error("from=2026-02-30")).toMatch(/YYYY-MM-DD/);
  });

  it("refuses a range that ends before it starts", () => {
    expect(error("from=2026-10-14&to=2026-10-13")).toMatch(/from must not be after to/);
  });

  it("reads whole-number ids", () => {
    expect(ok("actorUserId=7&buildingId=5&tenantId=42")).toMatchObject({ actorUserId: 7, buildingId: 5, tenantId: 42 });
  });

  it("reads the job and the contractor as whole numbers too", () => {
    expect(ok("jobId=9&contractorId=3")).toMatchObject({ contractorId: 3, jobId: 9 });
    expect(ok("jobId=9")).not.toHaveProperty("contractorId");
    expect(ok("contractorId=3")).not.toHaveProperty("jobId");
    expect(ok("jobId=&contractorId=")).toEqual({ exceptionsOnly: false, format: "json", sort: "occurredAt" });
  });

  it.each(["abc", "1.5", "-3", "0", "99999999999", "7;--"])("refuses %s as an id", (bad) => {
    expect(error(`actorUserId=${encodeURIComponent(bad)}`)).toMatch(/actorUserId must be a whole number/);
    expect(error(`buildingId=${encodeURIComponent(bad)}`)).toMatch(/buildingId/);
    expect(error(`tenantId=${encodeURIComponent(bad)}`)).toMatch(/tenantId/);
    expect(error(`jobId=${encodeURIComponent(bad)}`)).toMatch(/jobId must be a whole number/);
    expect(error(`contractorId=${encodeURIComponent(bad)}`)).toMatch(/contractorId must be a whole number/);
  });

  it("treats an action ending in a dot as a prefix and anything else as exact", () => {
    expect(ok("action=quote.approve").action).toEqual({ exact: "quote.approve" });
    expect(ok("action=denied").action).toEqual({ exact: "denied" });
    expect(ok("action=schedule.").action).toEqual({ prefix: "schedule." });
  });

  it.each(["Quote.Approve", "quote approve", "quote%approve", "'; --", ".leading", "a..b", "x".repeat(65)])(
    "refuses %j as an action",
    (bad) => {
      expect(error(`action=${encodeURIComponent(bad)}`)).toMatch(/action must be an action code/);
    },
  );

  it("reads exceptionsOnly leniently: true or 1 only", () => {
    expect(ok("exceptionsOnly=true").exceptionsOnly).toBe(true);
    expect(ok("exceptionsOnly=TRUE").exceptionsOnly).toBe(true);
    expect(ok("exceptionsOnly=1").exceptionsOnly).toBe(true);
    expect(ok("exceptionsOnly=false").exceptionsOnly).toBe(false);
    expect(ok("exceptionsOnly=").exceptionsOnly).toBe(false);
  });

  it("reads sort and format", () => {
    expect(ok("sort=impact").sort).toBe("impact");
    expect(ok("sort=occurredAt").sort).toBe("occurredAt");
    expect(ok("format=csv").format).toBe("csv");
    expect(error("sort=amount")).toMatch(/sort must be/);
    expect(error("format=xml")).toMatch(/format must be/);
  });
});

describe("buildDecisionWhere", () => {
  it("is empty with no filters", () => {
    expect(buildDecisionWhere(ok(""))).toEqual({ params: [], whereSql: "" });
  });

  it("binds every value and writes only literal SQL", () => {
    const { params, whereSql } = buildDecisionWhere(
      ok("from=2026-10-01&to=2026-10-13&actorUserId=7&action=quote.approve&buildingId=5&tenantId=42&exceptionsOnly=true"),
    );

    expect(whereSql).toBe(
      "WHERE OccurredAt >= @From AND OccurredAt < @To AND ActorUserId = @ActorUserId AND Action = @Action AND BuildingId = @BuildingId AND TenantId = @TenantId AND IsException = 1",
    );
    expect(whereSql).not.toMatch(/2026|quote|\b42\b/);
    expect(params.map((p) => p.name)).toEqual(["From", "To", "ActorUserId", "Action", "BuildingId", "TenantId"]);
  });

  it("binds the job and the contractor too: no value is ever written into the SQL", () => {
    const { params, whereSql } = buildDecisionWhere(ok("jobId=90210&contractorId=31337&buildingId=5"));

    expect(whereSql).not.toMatch(/90210|31337/);
    expect(params).toEqual([
      { name: "BuildingId", type: TYPES.Int, value: 5 },
      { name: "JobId", type: TYPES.Int, value: 90210 },
      { name: "ContractorId", type: TYPES.Int, value: 31337 },
    ]);
  });

  describe("by job", () => {
    it("is an equality on the JobId column, bound", () => {
      const { params, whereSql } = buildDecisionWhere(ok("jobId=9"));

      expect(whereSql).toBe("WHERE JobId = @JobId");
      expect(params).toEqual([{ name: "JobId", type: TYPES.Int, value: 9 }]);
    });
  });

  describe("by contractor", () => {
    const CLAUSE =
      "(TRY_CAST(JSON_VALUE([After], '$.contractorId') AS INT) = @ContractorId OR TRY_CAST(JSON_VALUE([Before], '$.contractorId') AS INT) = @ContractorId)";

    it("reads the id the row carries in `after` or in `before`, bound, in brackets so it can't swallow the other filters", () => {
      const { params, whereSql } = buildDecisionWhere(ok("contractorId=3"));

      expect(whereSql).toBe(`WHERE ${CLAUSE}`);
      expect(params).toEqual([{ name: "ContractorId", type: TYPES.Int, value: 3 }]);
    });

    it("stays inside its brackets when other filters join it with AND", () => {
      const { whereSql } = buildDecisionWhere(ok("jobId=9&contractorId=3&exceptionsOnly=true"));

      expect(whereSql).toBe(`WHERE JobId = @JobId AND ${CLAUSE} AND IsException = 1`);
    });

    // The ledger can't be run here, so this reads the clause the way SQL Server
    // would: a row matches when either column's JSON holds the id.
    const matches = (sql: string, row: { after: unknown; before: unknown }, id: number): boolean => {
      const terms = [...sql.matchAll(/TRY_CAST\(JSON_VALUE\(\[(After|Before)\], '\$\.contractorId'\) AS INT\) = @ContractorId/g)];
      return terms.some((term) => {
        const json = (term[1] === "After" ? row.after : row.before) as { contractorId?: unknown } | null;
        return json?.contractorId === id;
      });
    };

    it("finds a deletion written before `after` was filled in, through `before`", () => {
      const { whereSql } = buildDecisionWhere(ok("contractorId=3"));
      const oldDeletion = { after: null, before: { amount: 500, contractorId: 3, contractorName: "Acme", quoteNumber: "QT-9-1" } };

      expect(matches(whereSql, oldDeletion, 3)).toBe(true);
      expect(matches(whereSql, oldDeletion, 8)).toBe(false);
    });

    it("finds a row through `after`, and a contractor swap through the old contractor in `before`", () => {
      const { whereSql } = buildDecisionWhere(ok("contractorId=3"));

      expect(matches(whereSql, { after: { contractorId: 3 }, before: null }, 3)).toBe(true);
      expect(matches(whereSql, { after: { contractorId: 8 }, before: { contractorId: 3 } }, 3)).toBe(true);
      expect(matches(whereSql, { after: { contractorId: 8 }, before: { contractorId: 9 } }, 3)).toBe(false);
      expect(matches(whereSql, { after: null, before: null }, 3)).toBe(false);
    });
  });

  it("matches the DATETIME2(3) column's scale so the index can seek", () => {
    const { params } = buildDecisionWhere(ok("from=2026-10-01&to=2026-10-13"));
    for (const p of params) {
      expect(p.type).toBe(TYPES.DateTime2);
      expect(p.options).toEqual({ scale: 3 });
      expect(p.value).toBeInstanceOf(Date);
    }
  });

  it("turns a domain prefix into an escaped LIKE", () => {
    const { params, whereSql } = buildDecisionWhere(ok("action=rent_review."));
    expect(whereSql).toBe("WHERE Action LIKE @ActionPrefix ESCAPE '\\'");
    // The underscore is a LIKE wildcard and must be escaped.
    expect(params).toEqual([{ name: "ActionPrefix", type: TYPES.NVarChar, value: "rent\\_review.%" }]);
  });
});

describe("escapeLike", () => {
  it("escapes the wildcards and the escape character", () => {
    expect(escapeLike("a_b%c[d]e\\f")).toBe("a\\_b\\%c\\[d]e\\\\f");
    expect(escapeLike("schedule.")).toBe("schedule.");
  });
});
