// What the manager's "Covering" screen shows: who is away (and why, and until when),
// what is waiting on them and what the engine would do with each item, and what has
// already moved and to whom. Built from the live picture (view.ts), so it is right
// even while the engine is off or in dry run; the manager sees their own team (a
// director or the CFO sees more).

import { holidayCalendarConfigured, inactivityDays, type CoverMode } from "./config";
import { canTakeBackMove, isMovable } from "./moves/domain";
import { inTeamOf, type CoverCaller } from "./access";
import { listRecentActions, type CoverActionRow } from "./coverActionStore";
import type { PlanEntry } from "./plan";
import type { LiveView } from "./view";
import type { Connection } from "tedious";
import type { AbsenceKind, CoverSource, Importance, ItemType } from "./types";

export interface PersonRef {
  name: string;
  userId: number;
}

export interface AwayDto {
  cover: (PersonRef & { source: CoverSource }) | null;
  endDate: string | null;
  itemCount: number;
  kind: AbsenceKind;
  lastSeenOn: string | null;
  movedCount: number;
  name: string;
  reason: string;
  returnDate: string | null;
  role: string;
  startDate: string | null;
  suggestedCount: number;
  userId: number;
}

export interface SuggestionDto {
  absence: { kind: AbsenceKind; reason: string; returnDate: string | null };
  /** Whether a live run would move it by itself, or only list it for a manager. */
  autoMove: boolean;
  canMove: boolean;
  cover: (PersonRef & { role: string; source: CoverSource }) | null;
  deepLink: string;
  dueAt: string | null;
  importance: Importance;
  itemId: string;
  itemType: ItemType;
  label: string;
  /** This kind of item can be moved from here at all (a leave approval cannot). */
  movable: boolean;
  owner: PersonRef;
  reason: string;
  whyNot: string | null;
}

export interface MovedDto {
  absenceKind: AbsenceKind;
  action: "escalated" | "reassigned";
  at: string;
  canTakeBack: boolean;
  coverActionId: number;
  from: PersonRef;
  itemId: string;
  itemType: ItemType;
  label: string;
  reason: string;
  returnDate: string | null;
  takenBack: boolean;
  to: PersonRef | null;
}

export interface OverviewDto {
  away: AwayDto[];
  calendar: "holidays" | "weekends_only";
  inactivity: { available: boolean; days: number; reason: "off" | "stale" | null };
  mode: CoverMode;
  moved: MovedDto[];
  suggested: SuggestionDto[];
  today: string;
}

const RECENT_DAYS = 14;

function whyNot(entry: PlanEntry): string | null {
  if (!isMovable(entry.item.move)) return "Leave approvals follow the reporting line, which the CFO or a director changes.";
  if (!entry.resolution.found) return "Nobody who may take it is available. Choose someone.";
  return null;
}

function suggestionOf(entry: PlanEntry, mode: CoverMode): SuggestionDto {
  const { absent, item, resolution } = entry;
  const blocked = whyNot(entry);
  return {
    absence: { kind: absent.kind, reason: absent.reason, returnDate: absent.returnDate },
    autoMove: entry.action !== "suggested",
    canMove: mode === "live" && blocked === null,
    cover: resolution.found ? { name: resolution.name, role: resolution.role, source: resolution.source, userId: resolution.userId } : null,
    deepLink: item.deepLink,
    dueAt: item.dueAt ? item.dueAt.toISOString() : null,
    importance: item.importance,
    itemId: item.id,
    itemType: item.type,
    label: item.label,
    movable: isMovable(item.move),
    owner: { name: absent.name, userId: absent.userId },
    reason: entry.reasonText,
    whyNot: blocked,
  };
}

function movedOf(row: CoverActionRow, names: ReadonlyMap<number, string>, takenBack: ReadonlySet<number>): MovedDto {
  return {
    absenceKind: row.absenceKind,
    action: row.action as "escalated" | "reassigned",
    at: row.createdAt.toISOString(),
    canTakeBack: canTakeBackMove(row.action, row.itemType),
    coverActionId: row.coverActionId,
    from: { name: names.get(row.fromUserId) ?? "Former staff member", userId: row.fromUserId },
    itemId: row.itemId,
    itemType: row.itemType,
    label: row.itemLabel,
    reason: row.reasonText,
    returnDate: row.returnDate,
    takenBack: takenBack.has(row.coverActionId),
    to: row.toUserId === null ? null : { name: names.get(row.toUserId) ?? "Former staff member", userId: row.toUserId },
  };
}

export async function buildOverview(connection: Connection, caller: CoverCaller, view: LiveView, mode: CoverMode): Promise<OverviewDto> {
  const names = new Map(view.state.directory.map((user) => [user.userId, user.name]));
  const roles = new Map(view.state.directory.map((user) => [user.userId, user.role]));
  const mine = (userId: number): boolean => inTeamOf(caller, roles.get(userId) ?? "");
  const recent = await listRecentActions(connection, RECENT_DAYS);
  const takenBack = new Set(recent.filter((row) => row.action === "taken_back" && row.relatedActionId !== null).map((row) => row.relatedActionId as number));
  const moved = recent.filter((row) => (row.action === "reassigned" || row.action === "escalated") && !row.dryRun && mine(row.fromUserId));
  const entries = view.plan.entries.filter((entry) => mine(entry.absent.userId));
  const away = view.absent.filter((person) => mine(person.userId));
  return {
    away: away.map((person): AwayDto => {
      const own = entries.filter((entry) => entry.absent.userId === person.userId);
      const delegate = view.context.delegates
        .filter((row) => row.userId === person.userId)
        .sort((a, b) => b.coverDelegateId - a.coverDelegateId)[0];
      return {
        cover: delegate ? { name: names.get(delegate.delegateUserId) ?? "Unknown", source: "delegate", userId: delegate.delegateUserId } : null,
        endDate: person.endDate,
        itemCount: view.items.filter((item) => item.ownerUserId === person.userId).length,
        kind: person.kind,
        lastSeenOn: person.lastSeenOn,
        movedCount: moved.filter((row) => row.fromUserId === person.userId && !takenBack.has(row.coverActionId)).length,
        name: person.name,
        reason: person.reason,
        returnDate: person.returnDate,
        role: person.role,
        startDate: person.startDate,
        suggestedCount: own.length,
        userId: person.userId,
      };
    }),
    calendar: holidayCalendarConfigured() ? "holidays" : "weekends_only",
    inactivity: { available: view.inactivityAvailable, days: inactivityDays(), reason: view.inactivityReason },
    mode,
    moved: moved.map((row) => movedOf(row, names, takenBack)),
    suggested: entries.map((entry) => suggestionOf(entry, mode)),
    today: view.today,
  };
}
