import { Connection } from "tedious";
import { executeQuery } from "./db";
import { ApprovalLimit } from "./functions/invoices";

const CACHE_TTL_MS = 5 * 60 * 1000;

let _cache: ApprovalLimit[] | null = null;
let _cacheExpiry = 0;

export async function getCachedApprovalLimits(connection: Connection): Promise<ApprovalLimit[]> {
  if (_cache && Date.now() < _cacheExpiry) return _cache;
  const rows = (await executeQuery(
    connection,
    `SELECT RoleName, MaxApprovalAmount FROM ApprovalLimits`,
  )) as ApprovalLimit[];
  _cache = rows;
  _cacheExpiry = Date.now() + CACHE_TTL_MS;
  return rows;
}

export function invalidateApprovalLimitsCache(): void {
  _cache = null;
  _cacheExpiry = 0;
}
