// The picture of cover right now: who is away, what is waiting on them, what the policy
// would do with each item and who the cover would be. Read-only. The engine acts on it,
// the manager's screen shows it, and a manager's tap re-reads it before moving anything
// (what was on screen is not trusted).

import type { Connection } from "tedious";
import { todayInDarwin } from "../darwinDate";
import { holidaysFromEnv, type Holidays } from "../escalation/businessTime";
import { detectAbsences } from "./absence";
import { accessLoggingOn, inactivityDays } from "./config";
import { latestActionsByItem } from "./coverActionStore";
import { loadInventory } from "./inventory";
import { loadCoverState, type CoverState } from "./load";
import { planCover, type Plan } from "./plan";
import type { AbsentPerson, CoverContext, CoverItem } from "./types";

export interface LiveView {
  absent: AbsentPerson[];
  context: CoverContext;
  holidays: Holidays;
  inactivityAvailable: boolean;
  inactivityReason: "off" | "stale" | null;
  items: CoverItem[];
  plan: Plan;
  state: CoverState;
  today: string;
}

export interface ViewOptions {
  accessLoggingOn?: boolean;
  inactivityDays?: number;
  now?: Date;
}

/** Who is away, without the work waiting on them: enough to ask whether one person is back. */
export interface Absences {
  absent: AbsentPerson[];
  context: CoverContext;
  holidays: Holidays;
  inactivityAvailable: boolean;
  inactivityReason: "off" | "stale" | null;
  now: Date;
  state: CoverState;
  today: string;
}

export async function loadAbsences(connection: Connection, options: ViewOptions = {}): Promise<Absences> {
  const now = options.now ?? new Date();
  const today = todayInDarwin(now);
  const holidays = holidaysFromEnv();
  const logging = options.accessLoggingOn ?? accessLoggingOn();
  const state = await loadCoverState(connection, today, logging);
  const detection = detectAbsences({
    accessLogNewestOn: state.accessLogNewestOn,
    accessLoggingOn: logging,
    holidays,
    inactivityDays: options.inactivityDays ?? inactivityDays(),
    lastSeenOn: state.lastSeenOn,
    leaves: state.leaves,
    staff: state.directory,
    today,
  });
  const context: CoverContext = {
    absentIds: new Set(detection.absent.map((person) => person.userId)),
    delegates: state.delegates,
    directory: state.directory,
    links: state.links,
    moneyFacts: state.facts,
    today,
  };
  return { absent: detection.absent, context, holidays, inactivityAvailable: detection.inactivityAvailable, inactivityReason: detection.inactivityReason, now, state, today };
}

export async function loadLiveView(connection: Connection, options: ViewOptions = {}): Promise<LiveView> {
  const { absent, context, holidays, inactivityAvailable, inactivityReason, now, state, today } = await loadAbsences(connection, options);
  const items =
    absent.length === 0
      ? []
      : await loadInventory(connection, {
          absent,
          context: { facts: state.facts, holidays, now, today },
          emailColumns: state.emailColumns,
          links: state.links,
          staff: state.staff,
        });
  const latest = items.length === 0 ? new Map() : await latestActionsByItem(connection);
  const plan = planCover({ absent, context, items, latest });
  return { absent, context, holidays, inactivityAvailable, inactivityReason, items, plan, state, today };
}
