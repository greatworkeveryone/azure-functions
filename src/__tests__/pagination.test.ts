import {
  MAX_LIST_ROWS,
  MAX_PAGE_SIZE,
  parsePagination,
  paginationSqlSuffix,
} from "../pagination";

describe("parsePagination", () => {
  function q(params: Record<string, string>): URLSearchParams {
    return new URLSearchParams(params);
  }

  test("returns inactive when neither page nor pageSize is provided", () => {
    const r = parsePagination(q({}));
    expect(r.active).toBe(false);
    expect(r.limit).toBe(MAX_LIST_ROWS); // safety ceiling still applies
    expect(r.offset).toBe(0);
  });

  test("activates pagination when page is provided", () => {
    const r = parsePagination(q({ page: "2", pageSize: "50" }));
    expect(r.active).toBe(true);
    expect(r.page).toBe(2);
    expect(r.pageSize).toBe(50);
    expect(r.offset).toBe(50);
    expect(r.limit).toBe(50);
  });

  test("clamps pageSize to MAX_PAGE_SIZE", () => {
    const r = parsePagination(q({ page: "1", pageSize: "9999" }));
    expect(r.pageSize).toBe(MAX_PAGE_SIZE);
    expect(r.limit).toBe(MAX_PAGE_SIZE);
  });

  test("treats non-positive page as 1 (defensive)", () => {
    expect(parsePagination(q({ page: "0", pageSize: "10" })).page).toBe(1);
    expect(parsePagination(q({ page: "-3", pageSize: "10" })).page).toBe(1);
  });

  test("treats non-numeric page as the default", () => {
    expect(parsePagination(q({ page: "abc", pageSize: "10" })).page).toBe(1);
  });

  test("activates with pageSize alone (defaults page to 1)", () => {
    const r = parsePagination(q({ pageSize: "25" }));
    expect(r.active).toBe(true);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(25);
    expect(r.offset).toBe(0);
  });
});

describe("paginationSqlSuffix", () => {
  test("returns OFFSET/FETCH NEXT clause for an active pagination", () => {
    const r = parsePagination(new URLSearchParams({ page: "3", pageSize: "20" }));
    expect(paginationSqlSuffix(r)).toBe(" OFFSET 40 ROWS FETCH NEXT 20 ROWS ONLY");
  });

  test("returns TOP-style clause for inactive (safety ceiling only)", () => {
    const r = parsePagination(new URLSearchParams({}));
    // Inactive: no OFFSET/FETCH, ceiling enforced via a separate TOP clause in
    // the caller's SELECT. Suffix is empty in this case.
    expect(paginationSqlSuffix(r)).toBe("");
  });
});
