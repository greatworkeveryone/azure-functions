// Mirrored in the frontend: per-procedure endorsement, independent of editing.
import { canReadProcedure } from "./procedureAudience";

export type EndorsementAuthority = "team" | "executive";
export const ENDORSER_ROLES = ["facilities_manager", "accounts_manager", "cfo", "director"];

export function canEndorseProcedure(roles: readonly string[], audience: readonly string[], authority: string = "team"): boolean {
  if (roles.includes("director")) return true;
  if (roles.includes("cfo")) return authority === "executive" || canReadProcedure(roles, audience);
  if (authority !== "team") return false;
  return roles.some(role => (role === "facilities_manager" || role === "accounts_manager") && canReadProcedure([role], audience));
}

export function canAccessProcedure(roles: readonly string[], audience: readonly string[], authority: string = "team"): boolean {
  return canReadProcedure(roles, audience) || (roles.includes("cfo") && authority === "executive");
}
