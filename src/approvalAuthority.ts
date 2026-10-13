// Approval authority: who may approve a quote, invoice or purchase order, and
// who it escalates to. Money control; the CFO signs off on these rules.
//
// One pure module, kept byte-for-byte identical in both repos:
//   rpcc-functions  src/approvalAuthority.ts          enforces
//   command-centre  src/helpers/approvalAuthority.ts  explains (buttons, hints)
// Change both copies together, along with the shared vectors in
// src/__tests__/approvalAuthority.test.ts and src/helpers/approvalAuthority.test.ts.
//
// Pure: no I/O, no clock, no environment. The backend loads the facts in
// src/approvalAuthority-db.ts.

export type Subject = "quote" | "invoice" | "purchase_order";

/** One ApprovalLimits row. `limit: null` is an explicit NULL row: unlimited. */
export interface RoleLimit {
  limit: number | null;
  role: string;
}

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
  // PLAN WP20 slots "cfo" in here, on its own line, immediately before director.
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
  invoice: Object.freeze(["accounts", "accounts_manager", "admin", "director"]),
  purchase_order: Object.freeze(["facilities_manager", "accounts_manager", "admin", "director"]),
  quote: Object.freeze(["facilities_manager", "accounts", "accounts_manager", "admin", "director"]),
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
 * Who can approve this item, in escalation order, and whether the director
 * gate applies. An amount that is not a finite number, or is negative, counts
 * as 0. `attribution` plays no part in routing.
 *
 * effectiveDirectorThreshold: facts.directorThreshold when it is a finite
 * number > 0; otherwise the highest non-null limit over every non-director
 * row, including roles that cannot approve this subject and legacy roles
 * nobody holds (parity with requiresDirectorApproval in invoices.ts); null
 * when there is none. Reported on residences too, where it does not apply.
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
 * directorRequired is always false.
 */
export function decideAuthority(input: AuthorityInput, facts: AuthorityFacts): AuthorityResult {
  throw new Error(`decideAuthority(${input.subject}, ${facts.today}): not implemented yet (WP43a)`);
}

/**
 * Whether `identity` may approve this item. Checks run in this order and the
 * first that applies decides:
 *  1. creator: a purchase order cannot be approved by whoever created it
 *     (same userId, or same email ignoring case).
 *  2. residence: only an approver active on the day, or the director when the
 *     fallback is on, is allowed (basis "residence"); anyone else gets
 *     not_residence_approver.
 *  3. director_required: above the threshold only the director approves.
 *  4. own authority: the highest limit among the actor's roles that are
 *     eligible for the subject (director and NULL rows unlimited, a missing
 *     row 0). If it covers the amount: allowed, basis "own_authority".
 *  5. attribution: the actor holds a role in ATTRIBUTED_APPROVAL_ROLES whose
 *     row limit covers the amount. Without input.attribution:
 *     attribution_required. Allowed with basis "attributed" only when the
 *     named person has a userId or email, is not the actor, and would be
 *     allowed on their own authority for the same item; otherwise
 *     attribution_invalid.
 *  6. over_limit, or not_eligible when the actor holds no eligible or
 *     attributed role for the subject.
 * Role implication follows requireRole except for admin: facilities_manager
 * implies facilities, accounts_manager implies accounts, director implies
 * every role but admin; nothing implies admin and admin implies nothing.
 * On every denial, actorLimit is the highest limit the actor holds for the
 * subject, own or attributed (null = unlimited, undefined = holds none).
 */
export function canApprove(identity: Identity, input: AuthorityInput, facts: AuthorityFacts): ApprovalDecision {
  throw new Error(`canApprove(${identity.roles.join(",")}, ${input.subject}, ${facts.today}): not implemented yet (WP43a)`);
}
