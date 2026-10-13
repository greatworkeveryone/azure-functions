import { HttpRequest } from "@azure/functions";
import { Connection, TYPES } from "tedious";
import { rolesForRequest } from "./auth";
import { executeQuery } from "./db";
import type { LedgerActor } from "./ledger";

/**
 * The signed-in person a decision is recorded against (PLAN §3.12). Call it
 * before opening the write's transaction: the role comes from the request's
 * (cached) role lookup and the AppUsers id from one indexed read, so neither
 * holds the tenant row lock.
 */
export async function ledgerActorFor(
  request: HttpRequest,
  connection: Connection,
  caller: { id: string; name: string },
): Promise<LedgerActor> {
  const roles = await rolesForRequest(request);
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 UserID FROM dbo.AppUsers WHERE EntraOid = @Oid AND IsActive = 1`,
    [{ name: "Oid", type: TYPES.NVarChar, value: caller.id }],
  );
  const userId = rows[0]?.UserID;
  return {
    kind: "user",
    name: caller.name,
    role: roles[0] ?? "unknown",
    userId: typeof userId === "number" ? userId : null,
  };
}
