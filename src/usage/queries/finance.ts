import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam } from "../../db";
import type { UsagePeriod } from "../period";
import { FINANCE_ACTION_LIKE, FINANCE_MODULE_KEYS, FINANCE_USER_ROLES, type UsageScope } from "../scope";
import { loadUsagePeople, peopleParams, type UsagePersonDto } from "./people";

// Finance usage (PLAN §14): the CFO's view. Her own team's use of Floorplan (accounts,
// accounts_manager, cfo and admin people, time in finance pages only), the money decisions recorded
// in the DecisionLedger, and MYOB calls by operation, outcome and person. No other role's activity
// and no other module appears for the CFO, whatever filters the request carries (scope.ts).

export interface UsageFinanceFilter {
  role: string | null;
  scope: UsageScope;
  userId: number | null;
}

export interface UsageFinanceDto {
  decisions: { actors: { actor: string; count: number; role: string | null }[]; byAction: { action: string; count: number }[] };
  modules: { moduleKey: string; people: number; seconds: number }[];
  myob: { byOperation: { failed: number; ok: number; operation: string }[]; byPerson: { failed: number; ok: number; person: string }[] };
  people: UsagePersonDto[];
  period: { days: number; from: string; to: string };
  scope: UsageScope;
}

// The money decisions are selected by code prefix: the LIKE patterns travel as a JSON list in @Likes.
const MONEY_ACTION = `EXISTS (SELECT 1 FROM OPENJSON(@Likes) WHERE l.Action LIKE value)`;
const DECISION_WINDOW = `l.OccurredAt >= @FromUtc AND l.OccurredAt < @ToUtc AND ${MONEY_ACTION} AND (@UserId IS NULL OR l.ActorUserId = @UserId)`;
const MYOB_WINDOW = `l.Phase IN (N'response', N'error') AND l.OccurredAt >= @FromUtc AND l.OccurredAt < @ToUtc
  AND (@UserId IS NULL OR l.ActorOid = (SELECT TOP 1 EntraOid FROM dbo.AppUsers WHERE UserID = @UserId))`;
const OK_SQL = `SUM(CASE WHEN l.Phase = N'response' AND l.HttpStatus BETWEEN 200 AND 299 THEN 1 ELSE 0 END)`;
const FAILED_SQL = `SUM(CASE WHEN l.Phase = N'response' AND l.HttpStatus BETWEEN 200 AND 299 THEN 0 ELSE 1 END)`;

/** Whose role a userId filter names (lower case), or null when there is no such active person. */
export async function roleOfUser(connection: Connection, userId: number): Promise<string | null> {
  const rows = await executeQuery(connection, `SELECT LOWER(Role) AS Role FROM dbo.AppUsers WHERE UserID = @UserId`, [{ name: "UserId", type: TYPES.Int, value: userId }]);
  return (rows[0]?.Role as string | null | undefined) ?? null;
}

export async function loadUsageFinance(connection: Connection, period: UsagePeriod, filter: UsageFinanceFilter): Promise<UsageFinanceDto> {
  const roles = filter.role !== null ? [filter.role] : FINANCE_USER_ROLES;
  const people = await loadUsagePeople(connection, period, { moduleKeys: FINANCE_MODULE_KEYS, roles, userId: filter.userId });

  const modules = await executeQuery(
    connection,
    `SELECT d.ModuleKey, SUM(d.ActiveSeconds) AS Seconds, COUNT(DISTINCT d.UserId) AS People
       FROM dbo.UsageDaily d JOIN dbo.AppUsers u ON u.UserID = d.UserId
      WHERE d.ModuleKey IN (SELECT value FROM OPENJSON(@Keys)) AND LOWER(u.Role) IN (SELECT value FROM OPENJSON(@Roles))
        AND d.Day >= CAST(@From AS DATE) AND d.Day <= CAST(@To AS DATE) AND (@UserId IS NULL OR d.UserId = @UserId)
      GROUP BY d.ModuleKey ORDER BY SUM(d.ActiveSeconds) DESC`,
    [
      ...peopleParams(period, { roles, userId: filter.userId }),
      { name: "Keys", type: TYPES.NVarChar, value: JSON.stringify(FINANCE_MODULE_KEYS) },
    ],
  );

  const utc: SqlParam[] = [
    { name: "FromUtc", type: TYPES.DateTime2, value: period.fromUtc },
    { name: "ToUtc", type: TYPES.DateTime2, value: period.toUtc },
    { name: "UserId", type: TYPES.Int, value: filter.userId },
  ];
  const decisionParams: SqlParam[] = [...utc, { name: "Likes", type: TYPES.NVarChar, value: JSON.stringify(FINANCE_ACTION_LIKE) }];
  const byAction = await executeQuery(connection, `SELECT l.Action, COUNT(*) AS N FROM dbo.DecisionLedger l WHERE ${DECISION_WINDOW} GROUP BY l.Action ORDER BY COUNT(*) DESC`, decisionParams);
  const actors = await executeQuery(
    connection,
    `SELECT l.ActorName, LOWER(l.ActorRole) AS Role, COUNT(*) AS N FROM dbo.DecisionLedger l WHERE ${DECISION_WINDOW} GROUP BY l.ActorName, LOWER(l.ActorRole) ORDER BY COUNT(*) DESC`,
    decisionParams,
  );
  const byOperation = await executeQuery(connection, `SELECT l.Purpose, ${OK_SQL} AS Ok, ${FAILED_SQL} AS Failed FROM dbo.MyobApiLog l WHERE ${MYOB_WINDOW} GROUP BY l.Purpose ORDER BY COUNT(*) DESC`, utc);
  const byPerson = await executeQuery(connection, `SELECT l.ActorName, ${OK_SQL} AS Ok, ${FAILED_SQL} AS Failed FROM dbo.MyobApiLog l WHERE ${MYOB_WINDOW} GROUP BY l.ActorName ORDER BY COUNT(*) DESC`, utc);

  return {
    decisions: {
      actors: actors.map((row) => ({ actor: String(row.ActorName), count: Number(row.N), role: (row.Role as string | null) ?? null })),
      byAction: byAction.map((row) => ({ action: String(row.Action), count: Number(row.N) })),
    },
    modules: modules.map((row) => ({ moduleKey: String(row.ModuleKey), people: Number(row.People), seconds: Number(row.Seconds) })),
    myob: {
      byOperation: byOperation.map((row) => ({ failed: Number(row.Failed), ok: Number(row.Ok), operation: String(row.Purpose) })),
      byPerson: byPerson.map((row) => ({ failed: Number(row.Failed), ok: Number(row.Ok), person: String(row.ActorName) })),
    },
    people,
    period: { days: period.days, from: period.from, to: period.to },
    scope: filter.scope,
  };
}
