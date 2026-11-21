import { ACTION_ROLES, rolesFor, type Capability } from "../action-roles";
import type { SqlRow } from "../db";
import { normaliseRole } from "../escalation/roles";
import type { Viewer } from "./types";

/** Whether the viewer holds an action-roles capability: the same table the action's own gate is built from. */
export function holds(viewer: Viewer, capability: string): boolean {
  if (!(capability in ACTION_ROLES)) return false;
  const allowed = rolesFor(ACTION_ROLES[capability as Capability]) as string[];
  return viewer.roles.some((role) => allowed.includes(role));
}

export const hasRole = (viewer: Viewer, ...roles: string[]): boolean => viewer.roles.some((role) => roles.includes(role));

export function makeViewer(input: { email?: string | null; name: string; oid?: string | null; roles: readonly string[]; userId: number | null }): Viewer {
  return {
    email: input.email ?? null,
    name: input.name,
    oid: input.oid ?? null,
    roles: input.roles.map(normaliseRole).filter(Boolean),
    userId: input.userId,
  };
}

export const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

export const num = (value: unknown): number | null => (value === null || value === undefined || Number.isNaN(Number(value)) ? null : Number(value));

export const iso = (value: unknown): string | null => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null);

export const sameText = (a: string | null, b: string | null): boolean => a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

/** "Job #12 · Leaking roof" */
export function jobTitle(row: SqlRow, idColumn = "JobID"): string {
  const title = text(row.Title);
  return `Job #${row[idColumn]}${title ? ` · ${title}` : ""}`;
}

export const joinNames = (names: readonly string[]): string => (names.length <= 2 ? names.join(" or ") : `${names[0]} or ${names.length - 1} others`);

/** Whoever added a record does not approve it; a director is never blocked by that (the server's creatorRefusal). */
export function addedByViewer(viewer: Viewer, createdByOid: unknown, createdBy: unknown): boolean {
  if (hasRole(viewer, "director")) return false;
  const oid = text(createdByOid);
  if (oid && viewer.oid) return oid.toLowerCase() === viewer.oid.toLowerCase();
  return sameText(text(createdBy), viewer.name);
}
