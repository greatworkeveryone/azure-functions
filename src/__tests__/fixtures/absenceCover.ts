// Builders for the cover tests: people, an absence, an item and the context a cover is chosen in.
import type { AuthorityFacts } from "../../approvalAuthority";
import type { DirectoryUser } from "../../escalation/types";
import type { AbsentPerson, CoverContext, CoverItem } from "../../absenceCover/types";

export const TODAY = "2026-10-26"; // a Monday

export const user = (userId: number, role: string, name = `${role} ${userId}`): DirectoryUser => ({ email: `${name.replace(/\s/g, ".")}@example.com`.toLowerCase(), name, role, userId });

/** Facilities officer 1 away; manager 2, accounts 3, director 4, cfo 5, accounts manager 6, facilities officer 7, facilities manager 8. */
export const DIRECTORY: DirectoryUser[] = [
  user(1, "facilities", "Fay Facilities"),
  user(2, "facilities_manager", "Max Manager"),
  user(3, "accounts", "Ann Accounts"),
  user(4, "director", "Dee Director"),
  user(5, "cfo", "Cam Cfo"),
  user(6, "accounts_manager", "Ari Accounts Manager"),
  user(7, "facilities", "Sam Facilities"),
  user(8, "facilities_manager", "Mia Manager"),
  user(9, "admin", "Ada Admin"),
];

export const FACTS: AuthorityFacts = {
  directorThreshold: 50_000,
  isResidence: false,
  limits: [
    { limit: 2_000, role: "facilities" },
    { limit: 10_000, role: "facilities_manager" },
    { limit: 5_000, role: "accounts" },
    { limit: 20_000, role: "accounts_manager" },
    { limit: 50_000, role: "cfo" },
    { limit: null, role: "director" },
  ],
  residenceApprovers: [],
  residenceDirectorFallback: true,
  today: TODAY,
};

export const absent = (over: Partial<AbsentPerson> = {}): AbsentPerson => ({
  endDate: "2026-10-30",
  kind: "planned",
  lastSeenOn: null,
  leaveKind: "annual_leave",
  leaveRequestId: 11,
  name: "Fay Facilities",
  quietBusinessDays: null,
  reason: "On annual leave until 30/10/2026",
  reasonCode: "planned_leave",
  ref: "leave:11",
  returnDate: "2026-11-02",
  role: "facilities",
  startDate: "2026-10-26",
  userId: 1,
  ...over,
});

export const item = (over: Partial<CoverItem> = {}): CoverItem => ({
  capability: "editJobs",
  deepLink: "/jobs?jobId=12",
  detail: {},
  dueAt: new Date("2026-10-28T02:00:00Z"),
  id: "12",
  importance: "medium",
  importanceCode: "default",
  isTest: false,
  label: "Job #12 · Leaking roof · Tower A",
  minRole: null,
  money: null,
  move: "job_assignee",
  ownerUserId: 1,
  personal: false,
  raisedByUserId: null,
  type: "job",
  ...over,
} as CoverItem);

export const context = (over: Partial<CoverContext> = {}): CoverContext => ({
  absentIds: new Set([1]),
  delegates: [],
  directory: DIRECTORY,
  links: [],
  moneyFacts: FACTS,
  today: TODAY,
  ...over,
});
