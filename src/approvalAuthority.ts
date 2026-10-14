// Approval authority: who may approve a quote, invoice or purchase order, and
// who it escalates to. Money control; the CFO signs off on these rules.
//
// One pure module, kept byte-for-byte identical in both repos:
//   rpcc-functions  src/approvalAuthority.ts          enforces
//   command-centre  src/helpers/approvalAuthority.ts  explains (buttons, hints)
// Change both copies together, along with the shared vectors in
// src/__tests__/approvalAuthority.test.ts and src/helpers/approvalAuthority.test.ts
// and the SHA-256 of this file pinned there (CORE_SHA256), which fails the
// tests in whichever repo was changed alone.
//
// Pure: no I/O, no clock, no environment. The backend loads the facts in
// src/approvalAuthority-db.ts.

export type Subject = "quote" | "invoice" | "purchase_order";

/** One ApprovalLimits row. `limit: null` is an explicit NULL row: unlimited. Roles match trimmed and lower-cased. */
export interface RoleLimit {
  limit: number | null;
  role: string;
}

/** An ApprovalLimits row as SQL returns it, or as /getApprovalLimits sends it. */
export type ApprovalLimitRow =
  | { MaxApprovalAmount: number | null; RoleName: string }
  | { maxApprovalAmount: number | null; roleName: string };

/** Approves spend at a residence. `from`/`to`: YYYY-MM-DD, inclusive; a missing bound is open. */
export interface ResidenceApprover {
  displayName: string;
  email?: string;
  from?: string;
  relationship: "owner" | "occupant" | "property_manager";
  to?: string;
  userId: number;
}

export interface Identity {
  email?: string;
  roles: string[];
  userId?: number;
}

/** Who a plain-facilities approval is attributed to. The handler loads `roles` from AppUsers, never from the client. */
export interface Attribution {
  attributedTo: Identity & { displayName?: string };
}

export interface AuthorityInput {
  amount: number;
  /** YYYY-MM-DD that residence approver dates are checked against; defaults to facts.today. */
  at?: string;
  attribution?: Attribution;
  buildingId: number;
  createdBy?: { email?: string; userId?: number };
  jobId?: number;
  subject: Subject;
}

export interface AuthorityFacts {
  /** DIRECTOR_APPROVAL_THRESHOLD. null, or anything but a finite number > 0, means "derive it from the limits". */
  directorThreshold: number | null;
  isResidence: boolean;
  limits: RoleLimit[];
  residenceApprovers: ResidenceApprover[];
  residenceDirectorFallback: boolean;
  /** YYYY-MM-DD in Australia/Darwin. */
  today: string;
}

/** One step of an escalation route. */
export interface Approver {
  basis: "role_limit" | "director_threshold" | "residence";
  displayName?: string;
  kind: "role" | "user";
  limit: number | null;
  role?: string;
  userId?: number;
}

export interface AuthorityResult {
  directorRequired: boolean;
  effectiveDirectorThreshold: number | null;
  isResidence: boolean;
  route: Approver[];
}

export type DenyReason =
  | "creator"
  | "director_required"
  | "over_limit"
  | "not_eligible"
  | "not_residence_approver"
  | "attribution_required"
  | "attribution_invalid";

export type ApprovalBasis = "own_authority" | "attributed" | "residence";

export interface AttributedPerson {
  displayName?: string;
  email?: string;
  userId?: number;
}

export type ApprovalDecision =
  | { allowed: true; attributedTo?: AttributedPerson; basis: ApprovalBasis }
  | { actorLimit: number | null | undefined; allowed: false; reason: DenyReason };

/** The approval ladder, lowest first. Breaks ties between route levels with equal limits. */
export const ROLE_ORDER: readonly string[] = Object.freeze([
  "facilities",
  "accounts",
  "facilities_manager",
  "accounts_manager",
  "cfo",
  "director",
]);

/**
 * The single place that says which roles may approve which subject on their
 * own authority. Plain facilities is in none (Claude's default, 13 Oct 2026;
 * Connor may change it): adding it to a list is the whole change. Director
 * must stay in every list, since it ends every route. Admin approves only
 * within its own row and is never an escalation target.
 */
export const SUBJECT_ELIGIBLE_ROLES: Readonly<Record<Subject, readonly string[]>> = Object.freeze({
  invoice: Object.freeze(["accounts", "accounts_manager", "cfo", "admin", "director"]),
  purchase_order: Object.freeze(["facilities_manager", "accounts_manager", "cfo", "admin", "director"]),
  quote: Object.freeze(["facilities_manager", "accounts", "accounts_manager", "cfo", "admin", "director"]),
});

/**
 * Roles that may approve up to their own row limit only by attributing the
 * approval to someone who holds the authority themselves ("trust and
 * autonomy, but still traceable", Connor, 13 Oct 2026). Quotes only.
 */
export const ATTRIBUTED_APPROVAL_ROLES: Readonly<Record<Subject, readonly string[]>> = Object.freeze({
  invoice: Object.freeze([]),
  purchase_order: Object.freeze([]),
  quote: Object.freeze(["facilities"]),
});

/**
 * ApprovalLimits rows → RoleLimit[]: the one mapping both repos use. Role names
 * are trimmed and lower-cased, so a row seeded as 'Admin' applies to admin. A
 * limit that is not a number becomes NaN, which counts as no row; it never
 * becomes null, which would mean unlimited.
 */
export function toRoleLimits(rows: readonly ApprovalLimitRow[]): RoleLimit[] {
  return rows.map((row) => {
    const limit = "RoleName" in row ? row.MaxApprovalAmount : row.maxApprovalAmount;
    return { limit: limit === null ? null : Number(limit), role: roleKey("RoleName" in row ? row.RoleName : row.roleName) };
  });
}

/**
 * Who can approve this item, in escalation order, and whether the director
 * gate applies. `attribution` plays no part in routing.
 *
 * An unknown amount (anything but a finite number >= 0) needs the director:
 * directorRequired is true and the route is the director alone, on residences
 * too. Zero is a valid amount.
 *
 * effectiveDirectorThreshold: facts.directorThreshold when it is a finite
 * number > 0; otherwise the highest non-null limit over every non-director
 * row, including roles that cannot approve this subject and legacy roles
 * nobody holds (parity with the requiresDirectorApproval rule it replaced); null
 * when there is none. Role names compare trimmed and lower-cased. Reported on
 * residences too, where it does not apply.
 *
 * Non-residence: directorRequired = amount > 0 and amount > threshold. When
 * required, the route is the director alone; an unlimited row does not bypass
 * the gate. Otherwise the route is every sufficient level, then the director.
 * Levels are the subject's eligible roles other than admin and director; a
 * level is sufficient when its row limit >= amount (a NULL row is unlimited, a
 * missing row is never sufficient). Levels sort by limit ascending, unlimited
 * last, ties in ROLE_ORDER. Admin never appears in a route.
 *
 * Residence: the approvers active on `input.at ?? facts.today` (a malformed
 * date matches nobody), occupants and property managers first, then owners,
 * each group by displayName; then the director (basis "residence") when
 * residenceDirectorFallback is on. The role ladder does not apply and
 * directorRequired is false.
 */
export function decideAuthority(input: AuthorityInput, facts: AuthorityFacts): AuthorityResult {
  const threshold = directorThresholdOf(facts);
  const isResidence = facts.isResidence === true;
  if (!isKnownAmount(input.amount)) {
    return { directorRequired: true, effectiveDirectorThreshold: threshold, isResidence, route: [directorStep("director_threshold")] };
  }
  if (isResidence) {
    return {
      directorRequired: false,
      effectiveDirectorThreshold: threshold,
      isResidence,
      route: residenceRoute(facts, input.at ?? facts.today),
    };
  }
  const directorRequired = isDirectorRequired(input.amount, threshold);
  return {
    directorRequired,
    effectiveDirectorThreshold: threshold,
    isResidence,
    route: directorRequired ? [directorStep("director_threshold")] : ladderRoute(input.subject, input.amount, facts.limits),
  };
}

/**
 * Whether `identity` may approve this item. Checks run in this order and the
 * first that applies decides:
 *  1. creator: a purchase order cannot be approved by whoever created it
 *     (same userId, or same email ignoring case); another director can.
 *  2. unknown amount: only a director approves; anyone else gets
 *     director_required.
 *  3. residence: only an approver active on the day, or the director when the
 *     fallback is on, is allowed (basis "residence"); anyone else gets
 *     not_residence_approver.
 *  4. director_required: above the threshold only the director approves.
 *  5. own authority: the highest limit among the actor's roles that are
 *     eligible for the subject and have a row (a NULL row is unlimited; the
 *     director is unlimited without one). If it covers the amount: allowed,
 *     basis "own_authority".
 *  6. attribution: the actor holds a role in ATTRIBUTED_APPROVAL_ROLES whose
 *     row limit covers the amount. Without input.attribution:
 *     attribution_required. Allowed with basis "attributed" only when the
 *     named person has a userId or email, is not the actor, and would be
 *     allowed on their own authority for the same item; otherwise
 *     attribution_invalid.
 *  7. over_limit, or not_eligible when the actor holds no eligible or
 *     attributed role that has a row.
 * Role names compare trimmed and lower-cased, on rows and identities alike.
 * Role implication follows requireRole except for admin: facilities_manager
 * implies facilities, accounts_manager implies accounts, director implies
 * every role but admin; nothing implies admin and admin implies nothing.
 * On every denial, actorLimit is the highest limit the actor holds for the
 * subject, own or attributed (null = unlimited, undefined = no role with a row).
 */
export function canApprove(identity: Identity, input: AuthorityInput, facts: AuthorityFacts): ApprovalDecision {
  const roles = rolesOf(identity);
  const amount = input.amount;
  const own = heldLimit(roles, SUBJECT_ELIGIBLE_ROLES[input.subject], facts.limits);
  const attributed = heldLimit(roles, ATTRIBUTED_APPROVAL_ROLES[input.subject], facts.limits);
  const deny = (reason: DenyReason): ApprovalDecision => ({
    actorLimit: higherLimit(own, attributed),
    allowed: false,
    reason,
  });
  const directorOnly = (): ApprovalDecision =>
    roles.includes(DIRECTOR) ? { allowed: true, basis: "own_authority" } : deny("director_required");

  if (input.subject === "purchase_order" && input.createdBy && samePerson(identity, input.createdBy)) {
    return deny("creator");
  }
  if (!isKnownAmount(amount)) return directorOnly();
  if (facts.isResidence === true) {
    const day = input.at ?? facts.today;
    const isApprover = activeApprovers(facts.residenceApprovers, day).some((approver) => samePerson(identity, approver));
    const isFallback = facts.residenceDirectorFallback === true && roles.includes(DIRECTOR);
    return isApprover || isFallback ? { allowed: true, basis: "residence" } : deny("not_residence_approver");
  }
  if (isDirectorRequired(amount, directorThresholdOf(facts))) return directorOnly();
  if (covers(own, amount)) return { allowed: true, basis: "own_authority" };
  if (!covers(attributed, amount)) {
    return deny(own === undefined && attributed === undefined ? "not_eligible" : "over_limit");
  }

  const named = input.attribution?.attributedTo;
  if (!named) return deny("attribution_required");
  if (!hasIdentifier(named) || samePerson(identity, named)) return deny("attribution_invalid");
  const theirs = canApprove(named, { ...input, attribution: undefined }, facts);
  if (!theirs.allowed || theirs.basis !== "own_authority") return deny("attribution_invalid");
  return {
    allowed: true,
    attributedTo: { displayName: named.displayName, email: named.email, userId: named.userId },
    basis: "attributed",
  };
}

// ── Internals ────────────────────────────────────────────────────────────────

const ADMIN = "admin";
const DIRECTOR = "director";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

interface Person {
  email?: string;
  userId?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isKnownAmount(amount: number): boolean {
  return isFiniteNumber(amount) && amount >= 0;
}

function roleKey(role: unknown): string {
  return typeof role === "string" ? role.trim().toLowerCase() : "";
}

function directorThresholdOf(facts: AuthorityFacts): number | null {
  if (isFiniteNumber(facts.directorThreshold) && facts.directorThreshold > 0) return facts.directorThreshold;
  let highest: number | null = null;
  for (const row of facts.limits) {
    if (roleKey(row.role) === DIRECTOR || !isFiniteNumber(row.limit)) continue;
    if (highest === null || row.limit > highest) highest = row.limit;
  }
  return highest;
}

function isDirectorRequired(amount: number, threshold: number | null): boolean {
  return amount > 0 && threshold !== null && amount > threshold;
}

/** A role's row: null = unlimited, undefined = no usable row. */
function rowLimit(role: string, limits: readonly RoleLimit[]): number | null | undefined {
  let highest: number | undefined;
  for (const row of limits) {
    if (roleKey(row.role) !== role) continue;
    if (row.limit === null) return null;
    if (isFiniteNumber(row.limit) && (highest === undefined || row.limit > highest)) highest = row.limit;
  }
  return highest;
}

function covers(limit: number | null | undefined, amount: number): boolean {
  return limit === null || (limit !== undefined && limit >= amount);
}

function rolesOf(identity: Identity): string[] {
  return Array.isArray(identity.roles) ? identity.roles.map(roleKey) : [];
}

function holdsRole(roles: readonly string[], role: string): boolean {
  if (roles.includes(role)) return true;
  if (role === ADMIN) return false;
  if (roles.includes(DIRECTOR)) return true;
  if (role === "facilities") return roles.includes("facilities_manager");
  return role === "accounts" && roles.includes("accounts_manager");
}

/** Highest limit among the candidate roles the actor holds: null = unlimited, undefined = none with a row. */
function heldLimit(roles: readonly string[], candidates: readonly string[], limits: readonly RoleLimit[]): number | null | undefined {
  let highest: number | undefined;
  for (const role of candidates) {
    if (!holdsRole(roles, role)) continue;
    const limit = role === DIRECTOR ? null : rowLimit(role, limits);
    if (limit === null) return null;
    if (limit !== undefined && (highest === undefined || limit > highest)) highest = limit;
  }
  return highest;
}

function higherLimit(left: number | null | undefined, right: number | null | undefined): number | null | undefined {
  if (left === null || right === null) return null;
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function emailKey(email: string | undefined): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function hasIdentifier(person: Person): boolean {
  return isFiniteNumber(person.userId) || emailKey(person.email) !== "";
}

function samePerson(left: Person, right: Person): boolean {
  if (isFiniteNumber(left.userId) && left.userId === right.userId) return true;
  const email = emailKey(left.email);
  return email !== "" && email === emailKey(right.email);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function directorStep(basis: Approver["basis"]): Approver {
  return { basis, kind: "role", limit: null, role: DIRECTOR };
}

function ladderRank(role: string | undefined): number {
  const index = role === undefined ? -1 : ROLE_ORDER.indexOf(role);
  return index === -1 ? ROLE_ORDER.length : index;
}

function byLimitThenLadder(a: Approver, b: Approver): number {
  if (a.limit !== b.limit) {
    if (a.limit === null) return 1;
    if (b.limit === null) return -1;
    return a.limit - b.limit;
  }
  return ladderRank(a.role) - ladderRank(b.role) || compareText(a.role ?? "", b.role ?? "");
}

function ladderRoute(subject: Subject, amount: number, limits: readonly RoleLimit[]): Approver[] {
  const levels: Approver[] = [];
  for (const role of SUBJECT_ELIGIBLE_ROLES[subject]) {
    if (role === ADMIN || role === DIRECTOR) continue;
    const limit = rowLimit(role, limits);
    if (limit !== undefined && covers(limit, amount)) levels.push({ basis: "role_limit", kind: "role", limit, role });
  }
  return [...levels.sort(byLimitThenLadder), directorStep("role_limit")];
}

function relationshipRank(relationship: string): number {
  if (relationship === "occupant" || relationship === "property_manager") return 0;
  return relationship === "owner" ? 1 : -1;
}

function isActiveOn(approver: ResidenceApprover, day: string): boolean {
  const from = approver.from ?? "";
  const until = approver.to ?? "";
  if (from !== "" && !(ISO_DAY.test(from) && from <= day)) return false;
  return until === "" || (ISO_DAY.test(until) && day <= until);
}

function byRelationshipThenName(a: ResidenceApprover, b: ResidenceApprover): number {
  return (
    relationshipRank(a.relationship) - relationshipRank(b.relationship) ||
    compareText(a.displayName.toLowerCase(), b.displayName.toLowerCase()) ||
    compareText(a.displayName, b.displayName) ||
    a.userId - b.userId
  );
}

/** Approvers active on `day`, in route order. A malformed day matches nobody. */
function activeApprovers(approvers: readonly ResidenceApprover[], day: string): ResidenceApprover[] {
  if (!ISO_DAY.test(day)) return [];
  return approvers
    .filter((approver) => relationshipRank(approver.relationship) >= 0 && isActiveOn(approver, day))
    .sort(byRelationshipThenName);
}

function residenceRoute(facts: AuthorityFacts, day: string): Approver[] {
  const route = activeApprovers(facts.residenceApprovers, day).map(
    (approver): Approver => ({
      basis: "residence",
      displayName: approver.displayName,
      kind: "user",
      limit: null,
      userId: approver.userId,
    }),
  );
  return facts.residenceDirectorFallback === true ? [...route, directorStep("residence")] : route;
}
