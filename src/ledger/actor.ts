import type { HttpRequest } from "@azure/functions";
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { AppRole, rolesForRequest, verifiedIdentityFromRequest } from "../auth";
import { executeQuery } from "../db";
import type { LedgerActor } from "./types";

// Deliberately not re-exported from ./index: other packages' tests replace that
// module wholesale with jest.mock("../ledger").

// AppUsers holds one role per person, but X-Dev-Roles can list several. When
// there are several, the ledger records the most senior.
const ROLE_SENIORITY: readonly string[] = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.ACCOUNTS_APPROVAL,
  AppRole.FACILITIES_APPROVAL,
  AppRole.ACCOUNTS,
  AppRole.FACILITIES,
  AppRole.USER,
];

export function primaryRole(roles: readonly string[]): string | null {
  for (const role of ROLE_SENIORITY) {
    if (roles.includes(role)) return role;
  }
  return roles[0] ?? null;
}

/** A person actor from values a handler already holds. An empty role is left
 *  empty so the ledger's own validation refuses it. */
export function ledgerUserActor(input: {
  name: string;
  roles: readonly string[];
  userId: number | null;
}): LedgerActor {
  return {
    kind: "user",
    name: input.name,
    role: primaryRole(input.roles) ?? "",
    userId: input.userId,
  };
}

/**
 * The signed-in caller as a ledger actor: name from the verified token, role
 * from AppUsers (through rolesForRequest), id from AppUsers by Entra oid.
 * Null when the token doesn't verify; the handler answers 401.
 */
export async function resolveLedgerActor(
  request: HttpRequest,
  connection: Connection,
): Promise<LedgerActor | null> {
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return null;
  const roles = await rolesForRequest(request);
  const rows = await executeQuery(
    connection,
    `SELECT UserID FROM dbo.AppUsers WHERE EntraOid = @Oid AND IsActive = 1`,
    [{ name: "Oid", type: TYPES.NVarChar, value: identity.oid }],
  );
  const userId = (rows[0]?.UserID as number | undefined) ?? null;
  return ledgerUserActor({ name: identity.name, roles, userId });
}
