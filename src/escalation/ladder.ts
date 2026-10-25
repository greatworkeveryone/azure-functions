// Ladder resolution: who an escalation goes to (PLAN §3.7 rules 1-4). Pure: the
// caller loads the active users and passes them in, so the rules are tested
// without a database.
//
//  1. The target is the first ladder level, at or after the starting position,
//     with at least one active user, leaving out the raiser and, for authority
//     escalations, the people who prepared or created the subject. Empty
//     levels are skipped. One exception, asked for by the caller (`namedKeepRaiser`):
//     when the ladder is about the very person the named level is for (a next step's
//     owner is both), that level keeps them.
//  2. The `raiser_manager` token takes the raiser's manager role (roles.ts).
//  3. With nobody eligible on a fresh escalation (the only director raised it),
//     the target is the directors and NoIndependentTarget is set, so everyone
//     can see that nobody independent is looking at it.
//  4. TargetUserId is set when the raiser picks a person at the resolved level
//     (preferredUserId); otherwise it stays empty until someone acknowledges.
//
// Amount-based authority routes are WP21's: a ladder entry with the token
// `authority_route` is replaced by the steps of decideAuthority(...).route
// (src/approvalAuthority.ts), passed in as `authorityRoute`. Until WP21 passes
// one, that entry is skipped.

import { managerRoleFor, normaliseRole, ROLES, roleLabel } from "./roles";
import type { DirectoryUser, EscalationKind, LadderEntry } from "./types";

/** One step of the approval-authority route (WP43a decideAuthority(...).route). */
export interface AuthorityRouteStep {
  displayName?: string;
  kind: "role" | "user";
  role?: string;
  userId?: number;
}

export type LadderErrorCode = "empty_ladder" | "target_not_eligible";

export class LadderError extends Error {
  readonly code: LadderErrorCode;

  constructor(code: LadderErrorCode, message: string) {
    super(message);
    this.name = "LadderError";
    this.code = code;
  }
}

export type LevelSource = "role" | "raiser_manager" | "authority_route" | "user_target";

/** A ladder entry after tokens are resolved. */
export interface ExpandedLevel {
  /** 1-based position in the expanded ladder; this is what Escalations.Level stores. */
  position: number;
  /** The role everyone at this level holds; null for a level of named people. */
  role: string | null;
  slaHours: number | null;
  source: LevelSource;
  /** Named people (user steps); empty for role levels. */
  userIds: readonly number[];
}

export interface ExpandInput {
  authorityRoute?: readonly AuthorityRouteStep[];
  raiserRole?: string | null;
  /** People named when the escalation is raised, for `userTarget` entries. */
  userTargets?: readonly number[];
}

function slaOf(entry: LadderEntry): number | null {
  return typeof entry.slaHours === "number" && Number.isFinite(entry.slaHours) && entry.slaHours >= 0
    ? entry.slaHours
    : null;
}

/** Expands tokens and drops a level that would send it to the same role as the
 *  one before (a director raising goes to "the other directors" and the next
 *  level is also directors: nothing new to gain by moving up). */
export function expandLadder(ladder: readonly LadderEntry[], input: ExpandInput = {}): ExpandedLevel[] {
  const levels: Omit<ExpandedLevel, "position">[] = [];

  const push = (level: Omit<ExpandedLevel, "position">): void => {
    const previous = levels[levels.length - 1];
    if (previous && level.role !== null && previous.role === level.role) return;
    levels.push(level);
  };

  for (const entry of ladder) {
    const slaHours = slaOf(entry);
    if (entry.token === "authority_route") {
      for (const step of input.authorityRoute ?? []) {
        if (step.kind === "user" && typeof step.userId === "number") {
          push({ role: null, slaHours, source: "authority_route", userIds: [step.userId] });
        } else if (step.kind === "role" && normaliseRole(step.role)) {
          push({ role: normaliseRole(step.role), slaHours, source: "authority_route", userIds: [] });
        }
      }
    } else if (entry.token === "raiser_manager") {
      push({ role: managerRoleFor(input.raiserRole), slaHours, source: "raiser_manager", userIds: [] });
    } else if (entry.userTarget) {
      const named = (input.userTargets ?? []).filter((id) => Number.isInteger(id));
      if (named.length > 0) push({ role: null, slaHours, source: "user_target", userIds: named });
    } else if (normaliseRole(entry.role)) {
      push({ role: normaliseRole(entry.role), slaHours, source: "role", userIds: [] });
    }
  }
  return levels.map((level, index) => ({ ...level, position: index + 1 }));
}

/** The position of the first level holding `role` once tokens are expanded; the
 *  top level when none does (a caller that wants "the directors" gets the top). */
export function levelOfRole(ladder: readonly LadderEntry[], role: string, input: ExpandInput = {}): number {
  const levels = expandLadder(ladder, input);
  const wanted = normaliseRole(role);
  return levels.find((level) => level.role === wanted)?.position ?? Math.max(1, levels.length);
}

export interface ResolveInput {
  /** Everyone active in AppUsers. */
  activeUsers: readonly DirectoryUser[];
  authorityRoute?: readonly AuthorityRouteStep[];
  /** The subject's preparer or creator: left out of authority escalations. */
  excludeUserIds?: readonly number[];
  /** Env-list recipients per role, used only where a role has no eligible user
   *  (FACILITIES_MANAGER_EMAILS for facilities_manager). */
  fallbackEmails?: Readonly<Record<string, readonly string[]>>;
  /** The position to start looking from; 1 for a fresh escalation. */
  fromLevel?: number;
  kind: EscalationKind;
  ladder: readonly LadderEntry[];
  /** A level of named people (`userTarget`) keeps the raiser, who is the person the
   *  ladder is about and so who that level is for (a next step's owner). Left out,
   *  the raiser is never one of the people named, as for a decision request. */
  namedKeepRaiser?: boolean;
  /** What to do when nobody is eligible at or after fromLevel: aim at the
   *  directors and flag it (rule 3), or report that there is nowhere to go. */
  onNoTarget: "directors" | "none";
  /** Rule 4: the raiser picked this person at the resolved level. */
  preferredUserId?: number | null;
  raiser?: { email?: string | null; role?: string | null; userId?: number | null } | null;
  userTargets?: readonly number[];
}

export interface ResolvedTarget {
  /** Env-list recipients, only when the level has no eligible AppUser. */
  fallbackEmails: string[];
  /** Whether the ladder has another level after this one. */
  hasNextLevel: boolean;
  /** The resolved position (Escalations.Level). */
  level: number;
  levelCount: number;
  noIndependentTarget: boolean;
  role: string | null;
  /** Levels passed over as empty, for the ledger. */
  skippedLevels: number[];
  slaHours: number | null;
  source: LevelSource | "no_independent_target";
  /** Rule 4: set when the raiser picked a person, or when the level is one named person. */
  targetUserId: number | null;
  /** Eligible active users at the level, by name. */
  users: DirectoryUser[];
}

function byName(a: DirectoryUser, b: DirectoryUser): number {
  return a.name.localeCompare(b.name) || a.userId - b.userId;
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? "").trim().toLowerCase();
  return left !== "" && left === (b ?? "").trim().toLowerCase();
}

/** Rules 1-4. Returns null only when onNoTarget is "none" and nobody is eligible. */
export function resolveTarget(input: ResolveInput): ResolvedTarget | null {
  const levels = expandLadder(input.ladder, {
    authorityRoute: input.authorityRoute,
    raiserRole: input.raiser?.role,
    userTargets: input.userTargets,
  });
  if (levels.length === 0) throw new LadderError("empty_ladder", "This policy has no levels to send an escalation to");

  const raiser = input.raiser ?? null;
  const prepared = new Set<number>();
  if (input.kind === "authority") {
    for (const id of input.excludeUserIds ?? []) prepared.add(id);
  }
  const isRaiser = (user: DirectoryUser): boolean =>
    (typeof raiser?.userId === "number" && raiser.userId === user.userId) || sameAddress(user.email, raiser?.email);
  const eligible = (user: DirectoryUser, level: Pick<ExpandedLevel, "source">): boolean =>
    !prepared.has(user.userId) && ((input.namedKeepRaiser === true && level.source === "user_target") || !isRaiser(user));

  const fromLevel = Math.max(1, Math.trunc(input.fromLevel ?? 1));
  const skippedLevels: number[] = [];

  for (const level of levels) {
    if (level.position < fromLevel) continue;

    const users = input.activeUsers
      .filter((user) => (level.role === null ? level.userIds.includes(user.userId) : normaliseRole(user.role) === level.role))
      .filter((user) => eligible(user, level))
      .sort(byName);

    let fallbackEmails: string[] = [];
    if (users.length === 0 && level.role !== null) {
      fallbackEmails = (input.fallbackEmails?.[level.role] ?? []).filter((address) => !sameAddress(address, raiser?.email));
    }
    if (users.length === 0 && fallbackEmails.length === 0) {
      skippedLevels.push(level.position);
      continue;
    }

    let targetUserId: number | null = null;
    if (typeof input.preferredUserId === "number") {
      if (!users.some((user) => user.userId === input.preferredUserId)) {
        throw new LadderError("target_not_eligible", "That person isn't at the level this escalation goes to");
      }
      targetUserId = input.preferredUserId;
    } else if (level.role === null && users.length === 1) {
      targetUserId = users[0].userId;
    }

    return {
      fallbackEmails,
      hasNextLevel: level.position < levels.length,
      level: level.position,
      levelCount: levels.length,
      noIndependentTarget: false,
      role: level.role ?? (users.length === 1 ? normaliseRole(users[0].role) : null),
      skippedLevels,
      slaHours: level.slaHours,
      source: level.source,
      targetUserId,
      users,
    };
  }

  if (input.onNoTarget === "none") return null;

  // Rule 3. Aim at the directors, who may include nobody but the raiser.
  const top = levels[levels.length - 1];
  const directors = input.activeUsers
    .filter((user) => normaliseRole(user.role) === ROLES.director)
    .filter((user) => eligible(user, { source: "role" }))
    .sort(byName);
  if (typeof input.preferredUserId === "number" && !directors.some((user) => user.userId === input.preferredUserId)) {
    throw new LadderError("target_not_eligible", "That person isn't at the level this escalation goes to");
  }
  return {
    fallbackEmails: [],
    hasNextLevel: false,
    level: top.position,
    levelCount: levels.length,
    noIndependentTarget: true,
    role: ROLES.director,
    skippedLevels,
    slaHours: top.slaHours,
    source: "no_independent_target",
    targetUserId: typeof input.preferredUserId === "number" ? input.preferredUserId : null,
    users: directors,
  };
}

/** "Facilities manager (Adam)" or "Director (Ada, Bo +2 more)": the preview text. */
export function describeTarget(target: Pick<ResolvedTarget, "fallbackEmails" | "noIndependentTarget" | "role" | "targetUserId" | "users">): string {
  const label = roleLabel(target.role);
  const named = target.targetUserId === null ? target.users : target.users.filter((user) => user.userId === target.targetUserId);
  const names = named.map((user) => user.name);
  if (names.length === 0) {
    return target.fallbackEmails.length > 0 ? `${label} (${target.fallbackEmails.join(", ")})` : label;
  }
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` +${names.length - 3} more` : "";
  return `${label} (${shown}${more})`;
}
