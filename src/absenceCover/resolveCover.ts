// Who an item moves to, in this order, taking the first person who may have it
// (eligibility.ts) and passing over anyone who may not, with the reason:
//
//   1. the delegate the person nominated for these dates (one tied to this leave first)
//   2. their reporting-line manager (StaffReporting)
//   3. the team manager role: facilities_manager for facilities, accounts_manager for accounts
//   4. up the escalation ladder: their manager's role, then on to the director, or for
//      money the approval route of the amount, with the director last
//
// Steps 1 to 3 give a `reassigned`; step 4 is an `escalated`. Pure.

import { decideAuthority } from "../approvalAuthority";
import { managerRoleFor, normaliseRole, ROLES } from "../escalation/roles";
import type { DirectoryUser } from "../escalation/types";
import { ineligibleReason, INELIGIBLE_TEXT } from "./eligibility";
import type { AbsentPerson, CoverContext, CoverItem, CoverResolution, CoverSource, SkippedCover } from "./types";

const TEAM_MANAGER_ROLE: Record<string, string> = {
  accounts: ROLES.accountsManager,
  accounts_manager: ROLES.accountsManager,
  facilities: ROLES.facilitiesManager,
  facilities_manager: ROLES.facilitiesManager,
};

const byId = (a: DirectoryUser, b: DirectoryUser): number => a.userId - b.userId;

function activeUser(context: CoverContext, userId: number): DirectoryUser | undefined {
  return context.directory.find((user) => user.userId === userId);
}

function delegatesFor(absent: AbsentPerson, context: CoverContext): number[] {
  return context.delegates
    .filter((row) => row.userId === absent.userId && row.fromDate <= context.today && context.today <= row.toDate)
    .sort((a, b) => Number(b.leaveRequestId === absent.leaveRequestId) - Number(a.leaveRequestId === absent.leaveRequestId) || b.coverDelegateId - a.coverDelegateId)
    .map((row) => row.delegateUserId);
}

function managerOf(absent: AbsentPerson, context: CoverContext): number[] {
  const link = context.links.find((row) => row.userId === absent.userId);
  return link ? [link.managerId] : [];
}

function teamManagers(absent: AbsentPerson, context: CoverContext): number[] {
  const role = TEAM_MANAGER_ROLE[normaliseRole(absent.role)];
  return role ? context.directory.filter((user) => normaliseRole(user.role) === role).sort(byId).map((user) => user.userId) : [];
}

/** The roles up the ladder, nearest first. For money, the approval route of the amount. */
export function ladderRoles(item: CoverItem, absent: AbsentPerson, context: CoverContext): string[] {
  if (item.money && context.moneyFacts) {
    const amount = item.money.amount ?? Number.NaN;
    const route = decideAuthority({ amount, buildingId: item.money.buildingId, subject: item.money.subject }, context.moneyFacts).route;
    return route.flatMap((step) => (step.kind === "role" && step.role ? [step.role] : []));
  }
  const chain: string[] = [];
  let role = normaliseRole(absent.role);
  while (role !== ROLES.director && chain.length < 6) {
    role = managerRoleFor(role);
    chain.push(role);
  }
  return chain.length === 0 ? [ROLES.director] : chain;
}

function ladderCandidates(item: CoverItem, absent: AbsentPerson, context: CoverContext): number[] {
  return ladderRoles(item, absent, context).flatMap((role) =>
    context.directory.filter((user) => normaliseRole(user.role) === role).sort(byId).map((user) => user.userId),
  );
}

export function resolveCover(item: CoverItem, absent: AbsentPerson, context: CoverContext): CoverResolution {
  const skipped: SkippedCover[] = [];
  const tiers: { ids: number[]; source: CoverSource }[] = [
    { ids: delegatesFor(absent, context), source: "delegate" },
    { ids: managerOf(absent, context), source: "reporting_manager" },
    { ids: teamManagers(absent, context), source: "team_manager" },
    { ids: ladderCandidates(item, absent, context), source: "ladder" },
  ];
  const tried = new Set<number>();
  for (const { ids, source } of tiers) {
    for (const userId of ids) {
      const person = activeUser(context, userId);
      if (!person) {
        if (!tried.has(userId)) skipped.push({ name: `Someone no longer here (#${userId})`, reason: "is no longer an active user", source, userId });
        tried.add(userId);
        continue;
      }
      const why = ineligibleReason(item, person, context);
      if (why === null) {
        return { action: source === "ladder" ? "escalated" : "reassigned", found: true, name: person.name, role: person.role, skipped, source, userId };
      }
      if (!tried.has(userId)) skipped.push({ name: person.name, reason: INELIGIBLE_TEXT[why], source, userId });
      tried.add(userId);
    }
  }
  return { found: false, skipped };
}

/** "Sam, the person's nominated cover, is away too; so Alex, their manager." as a ledger sentence. */
export const SOURCE_TEXT: Record<CoverSource, string> = {
  delegate: "the cover they nominated",
  ladder: "the next person up the escalation ladder",
  reporting_manager: "their reporting-line manager",
  team_manager: "their team manager",
};
