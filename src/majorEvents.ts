import { AppRole } from "./auth";

export type EventDomain = "operational" | "financial";
export const EVENT_READ_ROLES = [AppRole.ADMIN, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR] as const;
export const OPERATIONAL_EVENT_MANAGERS = [AppRole.FACILITIES_APPROVAL, AppRole.DIRECTOR] as const;
export const FINANCIAL_EVENT_MANAGERS = [AppRole.CFO, AppRole.DIRECTOR] as const;
export function canManageEvent(roles: readonly string[], domain: EventDomain): boolean {
  return roles.some(role => (domain === "financial" ? FINANCIAL_EVENT_MANAGERS : OPERATIONAL_EVENT_MANAGERS).some(allowed => allowed === role));
}
export type EventAudience = "managers" | "accounts_managers" | "accounts_team" | "operational_staff";
export const EVENT_KINDS = ["cyclone", "flood", "shutdown", "major_works", "financial", "other", "utility_failure", "local_damage", "cyber_incident", "it_failure", "records_corruption", "fraud", "data_breach", "development", "refurbishment"] as const;
export function canReadEvent(roles: readonly string[], domain: EventDomain, audience: EventAudience = domain === "financial" ? "managers" : "operational_staff"): boolean {
  if (canManageEvent(roles, domain)) return true;
  const allowed: readonly string[] = audience === "operational_staff" ? EVENT_READ_ROLES : audience === "accounts_team" ? [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR] : audience === "accounts_managers" ? [AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR] : [];
  return roles.some(role => allowed.includes(role));
}
export interface EventPlan {
  buildingIds: number[];
  jobIds: number[];
  actions: { id: string; title: string; owner: string; due: string | null; done: boolean }[];
}
export interface EventInput {
  eventClass: "minor" | "major" | "project"; audience: EventAudience;
  title: string; domain: EventDomain; eventType: string; ownerName: string;
  startsAt: string; endsAt: string | null; brief: string; plan: EventPlan;
}
function text(value: unknown, name: string, max: number, optional = false): string {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${name} is required (maximum ${max} characters)`);
  return value.trim();
}
function date(value: unknown, name: string, optional = false): string | null {
  if (optional && (value === null || value === "" || value === undefined)) return null;
  const raw = text(value, name, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new Error(`${name} must be a valid date and time`);
  return new Date(raw).toISOString();
}
function ids(value: unknown, name: string, max: number, negative = false): number[] {
  if (!Array.isArray(value) || value.length > max || value.some(id => !Number.isInteger(id) || Math.abs(id) > 2147483647 || id === 0 || (!negative && id < 0))) throw new Error(`${name} must contain up to ${max} valid IDs`);
  return [...new Set(value)];
}
export function parseEventInput(body: Record<string, unknown>): EventInput {
  if (body.domain !== "operational" && body.domain !== "financial") throw new Error("Choose an operational or financial event");
  const eventType = text(body.eventType, "Event type", 24);
  if (!(EVENT_KINDS as readonly string[]).includes(eventType)) throw new Error("Unknown event type");
  const eventClass = body.eventClass ?? "major";
  if (!["minor", "major", "project"].includes(String(eventClass))) throw new Error("Choose Minor Event, Major Event or Project");
  const audience = body.audience ?? (body.domain === "financial" ? "managers" : "operational_staff");
  if (!["managers", "accounts_managers", "accounts_team", "operational_staff"].includes(String(audience))) throw new Error("Choose who can view and contribute");
  const startsAt = date(body.startsAt, "Start")!;
  const endsAt = date(body.endsAt, "End", true);
  if (endsAt && endsAt < startsAt) throw new Error("End must be after start");
  const plan = body.plan as Partial<EventPlan> | undefined;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Event plan is required");
  const buildingIds = ids(plan.buildingIds, "Buildings", 100, true);
  if (!buildingIds.length) throw new Error("Choose at least one affected building");
  const jobIds = ids(plan.jobIds, "Jobs", 100);
  if (!Array.isArray(plan.actions) || plan.actions.length > 100) throw new Error("Use up to 100 actions");
  const actions = plan.actions.map((action: unknown) => {
    if (!action || typeof action !== "object") throw new Error("Invalid action");
    const a = action as Record<string, unknown>;
    const id = text(a.id, "Action ID", 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || typeof a.done !== "boolean") throw new Error("Invalid action ID or state");
    return { id, title: text(a.title, "Action", 300), owner: text(a.owner, "Action owner", 160), due: date(a.due, "Action due", true), done: a.done };
  });
  if (new Set(actions.map(a => a.id)).size !== actions.length) throw new Error("Action IDs must be unique");
  return { eventClass: eventClass as EventInput["eventClass"], audience: audience as EventAudience, title: text(body.title, "Title", 160), domain: body.domain, eventType, ownerName: text(body.ownerName, "Event lead", 160), startsAt, endsAt, brief: text(body.brief, "Brief", 6000), plan: { buildingIds, jobIds, actions } };
}
export function parseEventEntry(body: Record<string, unknown>): { type: string; body: string; buildingId: number | null; area: string | null } {
  const type = text(body.type, "Update type", 24);
  if (!["update", "acknowledgement"].includes(type)) throw new Error("Unknown update type");
  const buildingId = body.buildingId === null || body.buildingId === undefined ? null : ids([body.buildingId], "Building", 1, true)[0];
  return { type, body: text(body.body, "Update", 6000), buildingId, area: text(body.area, "Area", 200, true) || null };
}
