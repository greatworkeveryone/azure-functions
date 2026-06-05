// Shared pagination + safety-ceiling helper for list endpoints.
// Behaviour:
//   - Page/pageSize ABSENT → pagination "inactive". Caller applies the
//     MAX_LIST_ROWS ceiling via SELECT TOP (or equivalent), no OFFSET/FETCH.
//   - Page or pageSize PRESENT → pagination "active". Caller appends
//     `paginationSqlSuffix(p)` to the SELECT and runs a separate COUNT(*)
//     for the unpaginated total.
//
// MAX_LIST_ROWS is a sanity ceiling, not a UX cap. If a list ever returns
// exactly MAX_LIST_ROWS, set truncated:true so the FE can surface it.

export const MAX_LIST_ROWS = 5000;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface PaginationParams {
  /** True if the caller opted into pagination via ?page= / ?pageSize=. */
  active: boolean;
  /** 1-based page index. Always >= 1. */
  page: number;
  /** Page size for an active pagination, clamped to [1, MAX_PAGE_SIZE]. */
  pageSize: number;
  /** Computed (page - 1) * pageSize for an active pagination, else 0. */
  offset: number;
  /** Effective row cap — MAX_LIST_ROWS when inactive, pageSize when active. */
  limit: number;
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

export function parsePagination(query: URLSearchParams): PaginationParams {
  const rawPage = query.get("page");
  const rawPageSize = query.get("pageSize");
  const active = rawPage !== null || rawPageSize !== null;

  if (!active) {
    return { active: false, page: 1, pageSize: 0, offset: 0, limit: MAX_LIST_ROWS };
  }

  const page = parsePositiveInt(rawPage, 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, parsePositiveInt(rawPageSize, DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * pageSize;
  return { active: true, page, pageSize, offset, limit: pageSize };
}

export function paginationSqlSuffix(p: PaginationParams): string {
  if (!p.active) return "";
  return ` OFFSET ${p.offset} ROWS FETCH NEXT ${p.pageSize} ROWS ONLY`;
}
