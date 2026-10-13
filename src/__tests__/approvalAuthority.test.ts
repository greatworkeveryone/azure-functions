import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppRole } from "../auth";
import { ApprovalLimit, requiresDirectorApproval } from "../functions/invoices";
import {
  ApprovalBasis,
  ApprovalDecision,
  Approver,
  ATTRIBUTED_APPROVAL_ROLES,
  Attribution,
  AuthorityFacts,
  AuthorityInput,
  canApprove,
  decideAuthority,
  DenyReason,
  Identity,
  ResidenceApprover,
  ROLE_ORDER,
  RoleLimit,
  Subject,
  SUBJECT_ELIGIBLE_ROLES,
  toRoleLimits,
} from "../approvalAuthority";

// ═══ Shared vectors ══════════════════════════════════════════════════════════
// This block is identical in rpcc-functions src/__tests__/approvalAuthority.test.ts
// and in its twin, command-centre src/helpers/approvalAuthority.test.ts.
// Copy it across whole whenever either side changes.

const TODAY = "2026-10-13";

/** Production ApprovalLimits on 13 Oct 2026, with the legacy row no current role uses. */
const PROD: RoleLimit[] = [
  { limit: 5000, role: "facilities" },
  { limit: 5000, role: "accounts" },
  { limit: 20000, role: "facilities_manager" },
  { limit: 20000, role: "accounts_manager" },
  { limit: 10000, role: "legacy_role" },
];
const ADMIN_50K: RoleLimit = { limit: 50000, role: "admin" };

const RESIDENTS: ResidenceApprover[] = [
  { displayName: "Owner Ola", relationship: "owner", userId: 201 },
  { displayName: "Occupant Cy", email: "Cy@Example.com", from: "2026-10-01", relationship: "occupant", to: "2026-10-31", userId: 202 },
  { displayName: "Agent Pam", from: "2026-10-14", relationship: "property_manager", userId: 203 },
  { displayName: "Occupant Bo", relationship: "occupant", to: "2026-10-12", userId: 204 },
  { displayName: "Agent Al", from: "2026-10-13", relationship: "property_manager", to: "2026-10-13", userId: 205 },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function ladder(limits: RoleLimit[], directorThreshold: number | null): AuthorityFacts {
  return { directorThreshold, isResidence: false, limits, residenceApprovers: [], residenceDirectorFallback: true, today: TODAY };
}

function residence(approvers: ResidenceApprover[], residenceDirectorFallback: boolean): AuthorityFacts {
  return { directorThreshold: null, isResidence: true, limits: PROD, residenceApprovers: approvers, residenceDirectorFallback, today: TODAY };
}

/** Frozen, so any mutation by the core throws. "envN" = DIRECTOR_APPROVAL_THRESHOLD. */
const FACTS: Record<string, AuthorityFacts> = deepFreeze({
  "accounts-high": ladder([{ limit: 30000, role: "accounts" }, { limit: 20000, role: "accounts_manager" }, { limit: 20000, role: "facilities_manager" }], 40000),
  "admin-50k-seeded": ladder([...PROD, ...toRoleLimits([{ MaxApprovalAmount: 50000, RoleName: "Admin" }])], null),
  "admin-null-seeded": ladder([...PROD, { limit: null, role: " Admin " }], null),
  "all-null": ladder([{ limit: null, role: "facilities_manager" }, { limit: null, role: "accounts_manager" }], null),
  "am-null": ladder([...PROD.filter((row) => row.role !== "accounts_manager"), { limit: null, role: "accounts_manager" }], null),
  "director-row": ladder([...PROD, { limit: 100000, role: "director" }], null),
  "facilities-high": ladder([{ limit: 30000, role: "facilities" }, { limit: 20000, role: "facilities_manager" }], 40000),
  "fm-high": ladder([{ limit: 60000, role: "facilities_manager" }, ADMIN_50K], 100000),
  "prod": ladder(PROD, null),
  "prod+admin": ladder([...PROD, ADMIN_50K], null),
  "prod+admin+env20k": ladder([...PROD, ADMIN_50K], 20000),
  "prod+env3k": ladder(PROD, 3000),
  "prod+env15k": ladder(PROD, 15000),
  "residence": residence(RESIDENTS, true),
  "residence-empty": residence([], false),
  "residence-no-fallback": residence(RESIDENTS, false),
});

const THRESHOLDS: Record<string, number | null> = {
  "accounts-high": 40000,
  "admin-50k-seeded": 50000,
  "admin-null-seeded": 20000,
  "all-null": null,
  "am-null": 20000,
  "director-row": 20000,
  "facilities-high": 40000,
  "fm-high": 100000,
  "prod": 20000,
  "prod+admin": 50000,
  "prod+admin+env20k": 20000,
  "prod+env3k": 3000,
  "prod+env15k": 15000,
  "residence": 20000,
  "residence-empty": 20000,
  "residence-no-fallback": 20000,
};

const ACTORS: Record<string, Identity> = deepFreeze({
  A: { email: "a@example.com", roles: ["accounts"], userId: 102 },
  AD: { email: "ad@example.com", roles: ["admin"], userId: 105 },
  AM: { email: "am@example.com", roles: ["accounts_manager"], userId: 104 },
  D: { email: "d@example.com", roles: ["director"], userId: 106 },
  F: { email: "f@example.com", roles: ["facilities"], userId: 101 },
  FM: { email: "fm@example.com", roles: ["facilities_manager"], userId: 103 },
  U: { email: "u@example.com", roles: ["user"], userId: 107 },
});
const COLUMNS = ["F", "A", "FM", "AM", "AD", "D", "U"];

// Route steps: role=limit (* unlimited); ! = basis director_threshold, ~ = basis
// residence, #n = user n. Outcomes, one per COLUMNS actor: ok own authority,
// at:n attributed to user n, rs residence; a denial is code:actorLimit
// (- none, * unlimited): ne not_eligible, ol over_limit, dr director_required,
// cr creator, nr not_residence_approver, ar attribution_required,
// ai attribution_invalid.
type LadderVector = [subject: Subject, facts: string, amounts: number[], route: string, outcomes: string];
const LADDER_VECTORS: LadderVector[] = [
  // prod: today's rows, no env, no admin row: the director gate sits at 20000.
  ["quote", "prod", [0, 4999.99, 5000], "accounts=5000 facilities_manager=20000 accounts_manager=20000 director=*", "ar:5000 ok ok ok ne:- ok ne:-"],
  ["quote", "prod", [5000.01, 20000], "facilities_manager=20000 accounts_manager=20000 director=*", "ol:5000 ol:5000 ok ok ne:- ok ne:-"],
  ["quote", "prod", [20000.01, 50000, 50000.01], "!director=*", "dr:5000 dr:5000 dr:20000 dr:20000 dr:- ok dr:-"],
  ["invoice", "prod", [0, 4999.99, 5000], "accounts=5000 accounts_manager=20000 director=*", "ne:- ok ne:- ok ne:- ok ne:-"],
  ["invoice", "prod", [5000.01, 20000], "accounts_manager=20000 director=*", "ne:- ol:5000 ne:- ok ne:- ok ne:-"],
  ["invoice", "prod", [20000.01, 50000, 50000.01], "!director=*", "dr:- dr:5000 dr:- dr:20000 dr:- ok dr:-"],
  ["purchase_order", "prod", [0, 4999.99, 5000, 5000.01, 20000], "facilities_manager=20000 accounts_manager=20000 director=*", "ne:- ne:- ok ok ne:- ok ne:-"],
  ["purchase_order", "prod", [20000.01, 50000, 50000.01], "!director=*", "dr:- dr:- dr:20000 dr:20000 dr:- ok dr:-"],
  // An unknown amount (negative, or not a finite number) needs the director, even at a residence.
  ["quote", "prod", [-5, NaN, Infinity, -Infinity], "!director=*", "dr:5000 dr:5000 dr:20000 dr:20000 dr:- ok dr:-"],
  ["invoice", "prod", [-5, NaN, Infinity, -Infinity], "!director=*", "dr:- dr:5000 dr:- dr:20000 dr:- ok dr:-"],
  ["purchase_order", "prod", [-5, NaN, Infinity, -Infinity], "!director=*", "dr:- dr:- dr:20000 dr:20000 dr:- ok dr:-"],
  ["quote", "residence-no-fallback", [NaN], "!director=*", "dr:5000 dr:5000 dr:20000 dr:20000 dr:- ok dr:-"],
  // prod+admin: an admin row of 50000 with no env lifts the derived gate to 50000.
  ["quote", "prod+admin", [0, 4999.99, 5000], "accounts=5000 facilities_manager=20000 accounts_manager=20000 director=*", "ar:5000 ok ok ok ok ok ne:-"],
  ["quote", "prod+admin", [5000.01, 20000], "facilities_manager=20000 accounts_manager=20000 director=*", "ol:5000 ol:5000 ok ok ok ok ne:-"],
  ["quote", "prod+admin", [20000.01, 50000], "director=*", "ol:5000 ol:5000 ol:20000 ol:20000 ok ok ne:-"],
  ["quote", "prod+admin", [50000.01], "!director=*", "dr:5000 dr:5000 dr:20000 dr:20000 dr:50000 ok dr:-"],
  ["invoice", "prod+admin", [0, 4999.99, 5000], "accounts=5000 accounts_manager=20000 director=*", "ne:- ok ne:- ok ok ok ne:-"],
  ["invoice", "prod+admin", [5000.01, 20000], "accounts_manager=20000 director=*", "ne:- ol:5000 ne:- ok ok ok ne:-"],
  ["invoice", "prod+admin", [20000.01, 50000], "director=*", "ne:- ol:5000 ne:- ol:20000 ok ok ne:-"],
  ["invoice", "prod+admin", [50000.01], "!director=*", "dr:- dr:5000 dr:- dr:20000 dr:50000 ok dr:-"],
  ["purchase_order", "prod+admin", [0, 4999.99, 5000, 5000.01, 20000], "facilities_manager=20000 accounts_manager=20000 director=*", "ne:- ne:- ok ok ok ok ne:-"],
  ["purchase_order", "prod+admin", [20000.01, 50000], "director=*", "ne:- ne:- ol:20000 ol:20000 ok ok ne:-"],
  ["purchase_order", "prod+admin", [50000.01], "!director=*", "dr:- dr:- dr:20000 dr:20000 dr:50000 ok dr:-"],
  // prod+env15k: an env threshold below the managers' limits wins from 15000.01.
  ["quote", "prod+env15k", [0, 4999.99, 5000], "accounts=5000 facilities_manager=20000 accounts_manager=20000 director=*", "ar:5000 ok ok ok ne:- ok ne:-"],
  ["quote", "prod+env15k", [5000.01], "facilities_manager=20000 accounts_manager=20000 director=*", "ol:5000 ol:5000 ok ok ne:- ok ne:-"],
  ["quote", "prod+env15k", [20000, 20000.01, 50000, 50000.01], "!director=*", "dr:5000 dr:5000 dr:20000 dr:20000 dr:- ok dr:-"],
  ["invoice", "prod+env15k", [0, 4999.99, 5000], "accounts=5000 accounts_manager=20000 director=*", "ne:- ok ne:- ok ne:- ok ne:-"],
  ["invoice", "prod+env15k", [5000.01], "accounts_manager=20000 director=*", "ne:- ol:5000 ne:- ok ne:- ok ne:-"],
  ["invoice", "prod+env15k", [20000, 20000.01, 50000, 50000.01], "!director=*", "dr:- dr:5000 dr:- dr:20000 dr:- ok dr:-"],
  ["purchase_order", "prod+env15k", [0, 4999.99, 5000, 5000.01], "facilities_manager=20000 accounts_manager=20000 director=*", "ne:- ne:- ok ok ne:- ok ne:-"],
  ["purchase_order", "prod+env15k", [20000, 20000.01, 50000, 50000.01], "!director=*", "dr:- dr:- dr:20000 dr:20000 dr:- ok dr:-"],
  // prod+admin+env20k: admin at 50000, with the env holding the gate at 20000.
  ["quote", "prod+admin+env20k", [0, 4999.99, 5000], "accounts=5000 facilities_manager=20000 accounts_manager=20000 director=*", "ar:5000 ok ok ok ok ok ne:-"],
  ["quote", "prod+admin+env20k", [5000.01, 20000], "facilities_manager=20000 accounts_manager=20000 director=*", "ol:5000 ol:5000 ok ok ok ok ne:-"],
  ["quote", "prod+admin+env20k", [20000.01, 50000, 50000.01], "!director=*", "dr:5000 dr:5000 dr:20000 dr:20000 dr:50000 ok dr:-"],
  ["invoice", "prod+admin+env20k", [0, 4999.99, 5000], "accounts=5000 accounts_manager=20000 director=*", "ne:- ok ne:- ok ok ok ne:-"],
  ["invoice", "prod+admin+env20k", [5000.01, 20000], "accounts_manager=20000 director=*", "ne:- ol:5000 ne:- ok ok ok ne:-"],
  ["invoice", "prod+admin+env20k", [20000.01, 50000, 50000.01], "!director=*", "dr:- dr:5000 dr:- dr:20000 dr:50000 ok dr:-"],
  ["purchase_order", "prod+admin+env20k", [0, 4999.99, 5000, 5000.01, 20000], "facilities_manager=20000 accounts_manager=20000 director=*", "ne:- ne:- ok ok ok ok ne:-"],
  ["purchase_order", "prod+admin+env20k", [20000.01, 50000, 50000.01], "!director=*", "dr:- dr:- dr:20000 dr:20000 dr:50000 ok dr:-"],
  // Unlimited (NULL) rows sort last and never bypass the director gate.
  ["quote", "am-null", [15000], "facilities_manager=20000 accounts_manager=* director=*", "ol:5000 ol:5000 ok ok ne:- ok ne:-"],
  ["quote", "am-null", [1000000], "!director=*", "dr:5000 dr:5000 dr:20000 dr:* dr:- ok dr:-"],
  ["invoice", "am-null", [15000], "accounts_manager=* director=*", "ne:- ol:5000 ne:- ok ne:- ok ne:-"],
  ["quote", "all-null", [1000000], "facilities_manager=* accounts_manager=* director=*", "ne:- ne:- ok ok ne:- ok ne:-"],
  // A director row is ignored: the director is always unlimited and never sets the gate.
  ["quote", "director-row", [150000], "!director=*", "dr:5000 dr:5000 dr:20000 dr:20000 dr:- ok dr:-"],
  // A row seeded as 'Admin' applies to admin, for its limit and for the gate, NULL or not.
  ["quote", "admin-50k-seeded", [20000.01], "director=*", "ol:5000 ol:5000 ol:20000 ol:20000 ok ok ne:-"],
  ["quote", "admin-null-seeded", [15000], "facilities_manager=20000 accounts_manager=20000 director=*", "ol:5000 ol:5000 ok ok ok ok ne:-"],
  ["quote", "admin-null-seeded", [20000.01], "!director=*", "dr:5000 dr:5000 dr:20000 dr:20000 dr:* ok dr:-"],
  // Implication: accounts_manager inherits the accounts row and facilities_manager
  // the facilities row (for attribution only); admin inherits nothing. A role
  // with no row gives no authority.
  ["quote", "accounts-high", [25000], "accounts=30000 director=*", "ne:- ok ol:20000 ok ne:- ok ne:-"],
  ["purchase_order", "accounts-high", [25000], "director=*", "ne:- ne:- ol:20000 ol:20000 ne:- ok ne:-"],
  ["quote", "facilities-high", [25000], "director=*", "ar:30000 ne:- ar:30000 ne:- ne:- ok ne:-"],
  ["quote", "fm-high", [55000], "facilities_manager=60000 director=*", "ne:- ne:- ok ne:- ol:50000 ok ne:-"],
  // Residences: no role ladder and no director gate, whatever the amount.
  ["quote", "residence", [1000000], "~#205=* ~#202=* ~#201=* ~director=*", "nr:5000 nr:5000 nr:20000 nr:20000 nr:- rs nr:-"],
  ["invoice", "residence", [100], "~#205=* ~#202=* ~#201=* ~director=*", "nr:- nr:5000 nr:- nr:20000 nr:- rs nr:-"],
  ["quote", "residence-no-fallback", [100], "~#205=* ~#202=* ~#201=*", "nr:5000 nr:5000 nr:20000 nr:20000 nr:- nr:* nr:-"],
  ["purchase_order", "residence-empty", [100], "", "nr:- nr:- nr:20000 nr:20000 nr:- nr:* nr:-"],
];

/** [at, route] on the "residence" facts: from/to are inclusive, a bad date matches nobody. */
const RESIDENCE_DAYS: [string, string][] = [
  ["2026-09-30", "~#204=* ~#201=* ~director=*"],
  ["2026-10-01", "~#204=* ~#202=* ~#201=* ~director=*"],
  ["2026-10-12", "~#204=* ~#202=* ~#201=* ~director=*"],
  ["2026-10-13", "~#205=* ~#202=* ~#201=* ~director=*"],
  ["2026-10-14", "~#203=* ~#202=* ~#201=* ~director=*"],
  ["2026-10-31", "~#203=* ~#202=* ~#201=* ~director=*"],
  ["2026-11-01", "~#203=* ~#201=* ~director=*"],
  ["13/10/2026", "~director=*"],
];

interface Case {
  actor: Identity;
  amount: number;
  at?: string;
  attributedTo?: Attribution["attributedTo"];
  createdBy?: { email?: string; userId?: number };
  facts: string;
  name: string;
  outcome: string;
  subject: Subject;
}
const FRAN = { displayName: "Fran Manager", email: "fm@example.com", roles: ["facilities_manager"], userId: 103 };
const CASES: Case[] = [
  // Attributed approval: plain facilities, quotes only, up to the facilities row.
  { actor: ACTORS.F, amount: 4999.99, facts: "prod", name: "facilities $4,999.99 with no attribution", outcome: "ar:5000", subject: "quote" },
  { actor: ACTORS.F, amount: 4999.99, attributedTo: FRAN, facts: "prod", name: "facilities attributing to a facilities_manager", outcome: "at:103", subject: "quote" },
  { actor: ACTORS.F, amount: 4999.99, attributedTo: { email: "f2@example.com", roles: ["facilities"], userId: 108 }, facts: "prod", name: "attributing to another facilities user", outcome: "ai:5000", subject: "quote" },
  { actor: ACTORS.F, amount: 4999.99, attributedTo: { roles: ["facilities_manager"], userId: 101 }, facts: "prod", name: "attributing to self by userId", outcome: "ai:5000", subject: "quote" },
  { actor: ACTORS.F, amount: 4999.99, attributedTo: { email: " F@Example.COM ", roles: ["facilities_manager"] }, facts: "prod", name: "attributing to self by email", outcome: "ai:5000", subject: "quote" },
  { actor: ACTORS.F, amount: 5000.01, attributedTo: FRAN, facts: "prod", name: "facilities $5,000.01 even with attribution", outcome: "ol:5000", subject: "quote" },
  { actor: ACTORS.FM, amount: 4000, facts: "prod", name: "facilities_manager $4,000 on own authority", outcome: "ok", subject: "quote" },
  { actor: ACTORS.FM, amount: 4000, attributedTo: { ...ACTORS.D }, facts: "prod", name: "attribution ignored when own authority covers", outcome: "ok", subject: "quote" },
  { actor: ACTORS.F, amount: 100, facts: "prod", name: "facilities on an invoice", outcome: "ne:-", subject: "invoice" },
  { actor: ACTORS.F, amount: 100, attributedTo: { ...ACTORS.AM }, facts: "prod", name: "attribution never applies to invoices", outcome: "ne:-", subject: "invoice" },
  { actor: ACTORS.F, amount: 100, attributedTo: FRAN, facts: "prod", name: "attribution never applies to purchase orders", outcome: "ne:-", subject: "purchase_order" },
  { actor: ACTORS.F, amount: 4999.99, attributedTo: { ...ACTORS.A }, facts: "prod", name: "attributing to accounts within its 5000", outcome: "at:102", subject: "quote" },
  { actor: ACTORS.F, amount: 4999.99, attributedTo: { ...ACTORS.AD }, facts: "prod", name: "attributing to admin with no row", outcome: "ai:5000", subject: "quote" },
  { actor: ACTORS.F, amount: 4999.99, attributedTo: { ...ACTORS.D }, facts: "prod", name: "attributing to the director", outcome: "at:106", subject: "quote" },
  { actor: ACTORS.F, amount: 4999.99, attributedTo: { displayName: "Someone", roles: ["director"] }, facts: "prod", name: "attribution needs a userId or email", outcome: "ai:5000", subject: "quote" },
  { actor: ACTORS.F, amount: 4999.99, attributedTo: { email: "x@example.com", roles: [], userId: 109 }, facts: "prod", name: "attributing to someone with no role", outcome: "ai:5000", subject: "quote" },
  { actor: ACTORS.F, amount: 4000, attributedTo: FRAN, facts: "prod+env3k", name: "attribution never bypasses the director gate", outcome: "dr:5000", subject: "quote" },
  { actor: ACTORS.F, amount: 100, attributedTo: FRAN, facts: "residence", name: "attribution never applies at a residence", outcome: "nr:5000", subject: "quote" },
  { actor: ACTORS.U, amount: 100, attributedTo: FRAN, facts: "prod", name: "a plain user cannot attribute", outcome: "ne:-", subject: "quote" },
  // Purchase-order creator rule.
  { actor: ACTORS.FM, amount: 1000, createdBy: { userId: 103 }, facts: "prod", name: "PO creator by userId", outcome: "cr:20000", subject: "purchase_order" },
  { actor: ACTORS.FM, amount: 1000, createdBy: { email: "FM@Example.COM" }, facts: "prod", name: "PO creator by email, any case", outcome: "cr:20000", subject: "purchase_order" },
  { actor: ACTORS.FM, amount: 1000, createdBy: { email: "am@example.com", userId: 104 }, facts: "prod", name: "PO created by someone else", outcome: "ok", subject: "purchase_order" },
  { actor: ACTORS.FM, amount: 1000, createdBy: { userId: 103 }, facts: "prod", name: "the creator rule is for purchase orders only", outcome: "ok", subject: "quote" },
  { actor: ACTORS.D, amount: 50000.01, createdBy: { userId: 106 }, facts: "prod", name: "director's own PO above the gate: director refused", outcome: "cr:*", subject: "purchase_order" },
  { actor: ACTORS.AM, amount: 50000.01, createdBy: { userId: 106 }, facts: "prod", name: "director's own PO above the gate: a manager cannot", outcome: "dr:20000", subject: "purchase_order" },
  { actor: { email: "d2@example.com", roles: ["director"], userId: 114 }, amount: 50000.01, createdBy: { userId: 106 }, facts: "prod", name: "director's own PO above the gate: a second director can", outcome: "ok", subject: "purchase_order" },
  { actor: { email: "", roles: ["facilities_manager"] }, amount: 1000, createdBy: { email: "" }, facts: "prod", name: "empty emails never match", outcome: "ok", subject: "purchase_order" },
  { actor: ACTORS.AD, amount: 1000, createdBy: { userId: 105 }, facts: "prod+admin", name: "creator check comes before the limit", outcome: "cr:50000", subject: "purchase_order" },
  // Residence approvers, by userId or email, on their dates.
  { actor: { roles: ["user"], userId: 202 }, amount: 1000000, facts: "residence", name: "active occupant by userId, any amount", outcome: "rs", subject: "quote" },
  { actor: { email: "cy@EXAMPLE.com", roles: ["user"] }, amount: 100, facts: "residence", name: "active occupant by email, any case", outcome: "rs", subject: "invoice" },
  { actor: { roles: ["user"], userId: 203 }, amount: 100, facts: "residence", name: "property manager before their start date", outcome: "nr:-", subject: "quote" },
  { actor: { roles: ["user"], userId: 203 }, amount: 100, at: "2026-10-14", facts: "residence", name: "property manager on their start date", outcome: "rs", subject: "purchase_order" },
  { actor: { roles: ["user"], userId: 204 }, amount: 100, facts: "residence", name: "occupant after their end date", outcome: "nr:-", subject: "quote" },
  { actor: { roles: ["user"], userId: 204 }, amount: 100, at: "2026-10-12", facts: "residence", name: "occupant on their end date", outcome: "rs", subject: "quote" },
  { actor: { roles: ["user"], userId: 205 }, amount: 100, facts: "residence", name: "one-day approver on the day", outcome: "rs", subject: "quote" },
  { actor: { roles: ["user"], userId: 205 }, amount: 100, at: "2026-10-14", facts: "residence", name: "one-day approver the day after", outcome: "nr:-", subject: "quote" },
  { actor: { roles: ["user"], userId: 202 }, amount: 100, createdBy: { userId: 202 }, facts: "residence", name: "residence PO creator", outcome: "cr:-", subject: "purchase_order" },
  { actor: { roles: ["user"], userId: 202 }, amount: 100, facts: "prod", name: "residence approvers count for nothing elsewhere", outcome: "ne:-", subject: "quote" },
  { actor: { roles: ["accounts_manager", "user"], userId: 202 }, amount: 1000000, facts: "residence-no-fallback", name: "staff who are approvers approve as approvers", outcome: "rs", subject: "quote" },
  { actor: { roles: ["user"], userId: 202 }, amount: NaN, facts: "residence", name: "an unknown amount at a residence needs the director", outcome: "dr:-", subject: "quote" },
  // Several roles, legacy roles, admin and director together.
  { actor: { roles: ["admin", "accounts_manager"], userId: 110 }, amount: 30000, facts: "prod+admin", name: "several roles take the highest limit", outcome: "ok", subject: "quote" },
  { actor: { roles: ["accounts", "facilities"], userId: 111 }, amount: 6000, facts: "prod", name: "accounts plus facilities over both limits", outcome: "ol:5000", subject: "quote" },
  { actor: { roles: ["legacy_role"], userId: 112 }, amount: 1, facts: "prod", name: "a legacy role holds no authority", outcome: "ne:-", subject: "quote" },
  { actor: ACTORS.AD, amount: 0, facts: "prod", name: "a role with no row cannot approve, even $0", outcome: "ne:-", subject: "quote" },
  { actor: { roles: [" Accounts_Manager "], userId: 115 }, amount: 15000, facts: "prod", name: "identity roles are trimmed and lower-cased", outcome: "ok", subject: "invoice" },
  { actor: { roles: ["admin", "director"], userId: 113 }, amount: 50000.01, facts: "prod+admin", name: "admin who is also director clears the gate", outcome: "ok", subject: "invoice" },
];

const BASIS_CODES: Record<ApprovalBasis, string> = { attributed: "at", own_authority: "ok", residence: "rs" };
const REASON_CODES: Record<DenyReason, string> = {
  attribution_invalid: "ai",
  attribution_required: "ar",
  creator: "cr",
  director_required: "dr",
  not_eligible: "ne",
  not_residence_approver: "nr",
  over_limit: "ol",
};

function limitCode(limit: number | null | undefined): string {
  if (limit === undefined) return "-";
  return limit === null ? "*" : String(limit);
}

function encodeDecision(decision: ApprovalDecision): string {
  if (!decision.allowed) return `${REASON_CODES[decision.reason]}:${limitCode(decision.actorLimit)}`;
  return decision.basis === "attributed" ? `at:${decision.attributedTo?.userId ?? "-"}` : BASIS_CODES[decision.basis];
}

function encodeRoute(route: Approver[]): string {
  return route
    .map((step) => {
      const mark = step.basis === "director_threshold" ? "!" : step.basis === "residence" ? "~" : "";
      return `${mark}${step.kind === "user" ? `#${step.userId}` : step.role}=${limitCode(step.limit)}`;
    })
    .join(" ");
}

function inputOf(subject: Subject, amount: number): AuthorityInput {
  return { amount, buildingId: 1, subject };
}

const LADDER_CASES = LADDER_VECTORS.flatMap(([subject, facts, amounts, route, outcomes]) =>
  amounts.map((amount) => ({ amount, facts, label: `${subject} ${facts} ${amount}`, outcomes, route, subject })),
);

describe("approval authority: shared vectors", () => {
  it.each(Object.entries(THRESHOLDS))("%s puts the director gate at %p", (name, threshold) => {
    expect(decideAuthority(inputOf("quote", 1), FACTS[name]).effectiveDirectorThreshold).toBe(threshold);
  });

  it.each([0, -1, NaN, Infinity])("ignores a configured threshold of %p", (threshold) => {
    const facts = { ...FACTS.prod, directorThreshold: threshold };
    expect(decideAuthority(inputOf("quote", 1), facts).effectiveDirectorThreshold).toBe(20000);
  });

  it.each(LADDER_CASES)("$label", ({ amount, facts, outcomes, route, subject }) => {
    const result = decideAuthority(inputOf(subject, amount), FACTS[facts]);
    expect(encodeRoute(result.route)).toBe(route);
    expect(result.directorRequired).toBe(route.startsWith("!"));
    expect(result.isResidence).toBe(FACTS[facts].isResidence);
    const decisions = COLUMNS.map((column) => encodeDecision(canApprove(ACTORS[column], inputOf(subject, amount), FACTS[facts])));
    expect(decisions.join(" ")).toBe(outcomes);
  });

  it.each(RESIDENCE_DAYS)("residence route on %s", (day, route) => {
    expect(encodeRoute(decideAuthority({ ...inputOf("quote", 1), at: day }, FACTS.residence).route)).toBe(route);
  });

  it.each(CASES)("$name", (vector) => {
    const input: AuthorityInput = {
      amount: vector.amount,
      at: vector.at,
      attribution: vector.attributedTo && { attributedTo: vector.attributedTo },
      buildingId: 1,
      createdBy: vector.createdBy,
      subject: vector.subject,
    };
    expect(encodeDecision(canApprove(vector.actor, input, FACTS[vector.facts]))).toBe(vector.outcome);
  });

  it("returns complete route steps", () => {
    expect(decideAuthority(inputOf("invoice", 100), FACTS.prod).route).toEqual([
      { basis: "role_limit", kind: "role", limit: 5000, role: "accounts" },
      { basis: "role_limit", kind: "role", limit: 20000, role: "accounts_manager" },
      { basis: "role_limit", kind: "role", limit: null, role: "director" },
    ]);
    expect(decideAuthority(inputOf("invoice", 20000.01), FACTS.prod).route).toEqual([
      { basis: "director_threshold", kind: "role", limit: null, role: "director" },
    ]);
    expect(decideAuthority(inputOf("quote", 1), FACTS["residence-no-fallback"]).route[0]).toEqual({
      basis: "residence",
      displayName: "Agent Al",
      kind: "user",
      limit: null,
      userId: 205,
    });
  });

  it("returns complete decisions, without the attributed person's roles", () => {
    const input: AuthorityInput = { amount: 4999.99, attribution: { attributedTo: FRAN }, buildingId: 1, subject: "quote" };
    expect(canApprove(ACTORS.F, input, FACTS.prod)).toEqual({
      allowed: true,
      attributedTo: { displayName: "Fran Manager", email: "fm@example.com", userId: 103 },
      basis: "attributed",
    });
    expect(canApprove(ACTORS.FM, input, FACTS.prod)).toEqual({ allowed: true, basis: "own_authority" });
    expect(canApprove(ACTORS.F, { ...input, attribution: undefined }, FACTS.prod)).toEqual({
      actorLimit: 5000,
      allowed: false,
      reason: "attribution_required",
    });
  });

  it("sends an unknown amount to the director alone, even at a residence; $0 is a known amount", () => {
    expect(decideAuthority(inputOf("quote", NaN), FACTS.residence)).toEqual({
      directorRequired: true,
      effectiveDirectorThreshold: 20000,
      isResidence: true,
      route: [{ basis: "director_threshold", kind: "role", limit: null, role: "director" }],
    });
    expect(decideAuthority(inputOf("quote", 0), FACTS.prod).directorRequired).toBe(false);
  });

  it("maps SQL rows and API rows the same way", () => {
    expect(toRoleLimits([{ MaxApprovalAmount: null, RoleName: " Admin " }, { maxApprovalAmount: 5000, roleName: "Facilities" }])).toEqual([
      { limit: null, role: "admin" },
      { limit: 5000, role: "facilities" },
    ]);
  });

  it("keeps the authority tables as agreed, frozen", () => {
    expect(ROLE_ORDER).toEqual(["facilities", "accounts", "facilities_manager", "accounts_manager", "cfo", "director"]);
    expect(SUBJECT_ELIGIBLE_ROLES).toEqual({
      invoice: ["accounts", "accounts_manager", "cfo", "admin", "director"],
      purchase_order: ["facilities_manager", "accounts_manager", "cfo", "admin", "director"],
      quote: ["facilities_manager", "accounts", "accounts_manager", "cfo", "admin", "director"],
    });
    expect(ATTRIBUTED_APPROVAL_ROLES).toEqual({ invoice: [], purchase_order: [], quote: ["facilities"] });
    for (const table of [SUBJECT_ELIGIBLE_ROLES, ATTRIBUTED_APPROVAL_ROLES]) {
      expect(Object.isFrozen(table) && Object.values(table).every((roles) => Object.isFrozen(roles))).toBe(true);
    }
    expect(Object.isFrozen(ROLE_ORDER)).toBe(true);
  });
});

// ═══ End of shared vectors ═══════════════════════════════════════════════════

describe("approval authority: backend only", () => {
  it("names only real app roles in its tables", () => {
    const tables = [ROLE_ORDER, ...Object.values(SUBJECT_ELIGIBLE_ROLES), ...Object.values(ATTRIBUTED_APPROVAL_ROLES)];
    const known: string[] = Object.values(AppRole);
    expect(tables.flat().filter((role) => !known.includes(role))).toEqual([]);
  });

  // WP20 put the CFO between accounts_manager and director. No cfo ApprovalLimits row
  // exists yet (the amount is open, Q8), so these use an assumed one.
  describe("the CFO between accounts_manager and director", () => {
    const CFO: Identity = { email: "cfo@example.com", roles: ["cfo"], userId: 108 };
    const withCfo: AuthorityFacts = ladder([...PROD, { limit: 50000, role: "cfo" }], 100000);
    const roles = (route: Approver[]): (string | undefined)[] => route.map((step) => step.role);

    it("sits just below the director in the escalation order", () => {
      expect(ROLE_ORDER.slice(-3)).toEqual(["accounts_manager", "cfo", "director"]);
    });

    it.each<Subject>(["quote", "invoice", "purchase_order"])("may approve a %s on its own authority", (subject) => {
      expect(SUBJECT_ELIGIBLE_ROLES[subject]).toContain("cfo");
    });

    it("is a step between the managers and the director once it has a limit", () => {
      expect(roles(decideAuthority(inputOf("invoice", 15000), withCfo).route)).toEqual(["accounts_manager", "cfo", "director"]);
      expect(roles(decideAuthority(inputOf("invoice", 30000), withCfo).route)).toEqual(["cfo", "director"]);
      expect(roles(decideAuthority(inputOf("quote", 30000), withCfo).route)).toEqual(["cfo", "director"]);
      expect(roles(decideAuthority(inputOf("purchase_order", 30000), withCfo).route)).toEqual(["cfo", "director"]);
      // above its limit and still under the director gate, only the director is left
      expect(roles(decideAuthority(inputOf("invoice", 60000), withCfo).route)).toEqual(["director"]);
    });

    it("comes after a manager with the same limit", () => {
      const tied = ladder([...PROD, { limit: 20000, role: "cfo" }], 100000);
      expect(roles(decideAuthority(inputOf("invoice", 15000), tied).route)).toEqual(["accounts_manager", "cfo", "director"]);
    });

    it("approves within its own limit and not beyond it", () => {
      expect(canApprove(CFO, inputOf("invoice", 30000), withCfo)).toEqual({ allowed: true, basis: "own_authority" });
      expect(canApprove(CFO, inputOf("invoice", 60000), withCfo)).toEqual({ actorLimit: 50000, allowed: false, reason: "over_limit" });
    });

    it("approves nothing until it has a limit row: no row, no authority", () => {
      for (const subject of ["quote", "invoice", "purchase_order"] as const) {
        expect(canApprove(CFO, inputOf(subject, 100), FACTS.prod)).toEqual({ actorLimit: undefined, allowed: false, reason: "not_eligible" });
        expect(roles(decideAuthority(inputOf(subject, 100), FACTS.prod).route)).not.toContain("cfo");
      }
    });
  });

  it("keeps the core pure: no imports, clock, environment or console", () => {
    const source = readFileSync(join(__dirname, "../approvalAuthority.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s|\brequire\(|\bDate\b|process\.|console\.|Math\.random/m);
  });

  // Parity with today's gate: every vector with a known amount, with no env
  // threshold and as a non-residence, must agree with requiresDirectorApproval.
  const parity: [string, Subject, number][] = [
    ...LADDER_CASES.map((row): [string, Subject, number] => [row.facts, row.subject, row.amount]),
    ...CASES.map((row): [string, Subject, number] => [row.facts, row.subject, row.amount]),
  ].filter(([, , amount]) => Number.isFinite(amount) && amount >= 0);
  it.each(parity)("director gate matches requiresDirectorApproval: %s %s %p", (name, subject, amount) => {
    const facts: AuthorityFacts = { ...FACTS[name], directorThreshold: null, isResidence: false };
    const rows: ApprovalLimit[] = facts.limits.map((row) => ({ MaxApprovalAmount: row.limit, RoleName: row.role }));
    expect(decideAuthority(inputOf(subject, amount), facts).directorRequired).toBe(requiresDirectorApproval(amount, rows));
  });

  it("departs from requiresDirectorApproval for unknown amounts, which now always need the director", () => {
    const rows: ApprovalLimit[] = PROD.map((row) => ({ MaxApprovalAmount: row.limit, RoleName: row.role }));
    const unknown = [-5, NaN, Infinity];
    expect(unknown.map((amount) => requiresDirectorApproval(amount, rows))).toEqual([false, false, true]);
    expect(unknown.map((amount) => decideAuthority(inputOf("quote", amount), FACTS.prod).directorRequired)).toEqual([true, true, true]);
  });
});
