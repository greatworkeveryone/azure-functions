// What a request to resolve an audience may carry. Everything is checked before the database is touched:
// ids are whole numbers, text is short, roles are real roles, and an unknown key is refused.

import { AppRole } from "../../auth";
import type { Parsed } from "../request";
import { BUILDING_CATEGORIES, CONTACT_KINDS, type AudienceRequest, type BuildingCategory, type BuildingSelection, type ContactKind } from "./types";

const fail = (error: string): { error: string; ok: false } => ({ error, ok: false });
/** Names the first key outside `allowed`. (request.ts's check words signature-like keys as a signature refusal, which would mislead here.) */
function unexpectedKey(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  const key = Object.keys(body).find((name) => !allowed.includes(name));
  return key === undefined ? null : `Unknown field "${key.slice(0, 40)}"`;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;

export const MAX_SELECTIONS = 200;
export const MAX_TYPED = 500;
const MAX_LEVELS = 60;
const MAX_TRADES = 50;
const MAX_TEXT = 100;
export const MAX_TYPED_CHARS = 320;
/** Roles an audience may name: every real role except the baseline user, who is not a team. */
export const STAFF_AUDIENCE_ROLES: readonly string[] = Object.values(AppRole).filter((role) => role !== AppRole.USER);

function texts(value: unknown, label: string, max: number, maxEach = MAX_TEXT): Parsed<string[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > max) return fail(`${label} must be a list of at most ${max}`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "" || entry.length > maxEach) return fail(`${label} must be short text`);
    out.push(entry.trim());
  }
  return { ok: true, value: [...new Set(out)] };
}

function ids(value: unknown, label: string): Parsed<number[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > MAX_SELECTIONS || !value.every(isId)) return fail(`${label} must be a list of building ids`);
  return { ok: true, value: [...new Set(value)] };
}

function parseSelections(value: unknown): Parsed<BuildingSelection[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SELECTIONS) return fail("Choose at least one building");
  // null means the whole building: choosing it wins over any levels named for the same building.
  const byBuilding = new Map<number, Set<string> | null>();
  for (const entry of value) {
    if (!isObject(entry)) return fail("Each building choice must be an object");
    const extra = unexpectedKey(entry, ["buildingId", "levels"]);
    if (extra) return fail(extra);
    if (!isId(entry.buildingId)) return fail("A building choice needs a building id");
    const levels = texts(entry.levels, "Levels", MAX_LEVELS);
    if (!levels.ok) return levels;
    const earlier = byBuilding.get(entry.buildingId);
    if (levels.value.length === 0 || earlier === null) byBuilding.set(entry.buildingId, null);
    else byBuilding.set(entry.buildingId, new Set([...(earlier ?? []), ...levels.value]));
  }
  return { ok: true, value: [...byBuilding].map(([buildingId, levels]) => ({ buildingId, levels: levels === null ? [] : [...levels] })) };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: readonly T[], label: string): Parsed<T[]> {
  if (value === undefined || value === null) return { ok: true, value: [...fallback] };
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry): entry is T => allowed.includes(entry as T))) return fail(`${label} must be one or more of: ${allowed.join(", ")}`);
  return { ok: true, value: [...new Set(value)] };
}

function parseTenancies(value: unknown): Parsed<NonNullable<AudienceRequest["tenancies"]>> {
  if (!isObject(value)) return fail("tenancies must be an object");
  const extra = unexpectedKey(value, ["selections", "contacts", "categories"]);
  if (extra) return fail(extra);
  const selections = parseSelections(value.selections);
  if (!selections.ok) return selections;
  const contacts = oneOf<ContactKind>(value.contacts, CONTACT_KINDS, CONTACT_KINDS, "contacts");
  if (!contacts.ok) return contacts;
  const categories = oneOf<BuildingCategory>(value.categories, BUILDING_CATEGORIES, ["commercial"], "categories");
  if (!categories.ok) return categories;
  return { ok: true, value: { categories: categories.value, contacts: contacts.value, selections: selections.value } };
}

function parseContractors(value: unknown): Parsed<NonNullable<AudienceRequest["contractors"]>> {
  if (!isObject(value)) return fail("contractors must be an object");
  const extra = unexpectedKey(value, ["trades", "buildingIds"]);
  if (extra) return fail(extra);
  const trades = texts(value.trades, "Trades", MAX_TRADES);
  if (!trades.ok) return trades;
  const buildingIds = ids(value.buildingIds, "buildingIds");
  if (!buildingIds.ok) return buildingIds;
  if (trades.value.length === 0 && buildingIds.value.length === 0) return fail("Choose a trade, a building or both for contractors");
  return { ok: true, value: { buildingIds: buildingIds.value, trades: trades.value } };
}

function parseStaff(value: unknown): Parsed<NonNullable<AudienceRequest["staff"]>> {
  if (!isObject(value)) return fail("staff must be an object");
  const extra = unexpectedKey(value, ["roles"]);
  if (extra) return fail(extra);
  const roles = texts(value.roles, "Roles", 10, 40);
  if (!roles.ok) return roles;
  if (roles.value.length === 0) return fail("Choose at least one staff role");
  const unknown = roles.value.find((role) => !STAFF_AUDIENCE_ROLES.includes(role));
  return unknown === undefined ? { ok: true, value: { roles: roles.value } } : fail(`"${unknown.slice(0, 40)}" is not a staff role`);
}

export function parseAudienceRequest(body: Record<string, unknown>): Parsed<AudienceRequest> {
  const extra = unexpectedKey(body, ["tenancies", "contractors", "staff", "typed"]);
  if (extra) return fail(extra);
  const typed = texts(body.typed, "Typed addresses", MAX_TYPED, MAX_TYPED_CHARS);
  if (!typed.ok) return typed;
  const request: AudienceRequest = { contractors: null, staff: null, tenancies: null, typed: typed.value };
  if (body.tenancies !== undefined && body.tenancies !== null) {
    const parsed = parseTenancies(body.tenancies);
    if (!parsed.ok) return parsed;
    request.tenancies = parsed.value;
  }
  if (body.contractors !== undefined && body.contractors !== null) {
    const parsed = parseContractors(body.contractors);
    if (!parsed.ok) return parsed;
    request.contractors = parsed.value;
  }
  if (body.staff !== undefined && body.staff !== null) {
    const parsed = parseStaff(body.staff);
    if (!parsed.ok) return parsed;
    request.staff = parsed.value;
  }
  if (!request.tenancies && !request.contractors && !request.staff && request.typed.length === 0) return fail("Choose who the email is for");
  return { ok: true, value: request };
}
