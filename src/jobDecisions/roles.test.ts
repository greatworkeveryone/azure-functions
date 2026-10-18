/// <reference types="jest" />
import { ACTION_ROLES } from "../action-roles";
import { ESCALATION_ROLES } from "../escalation/http";
import { FLAG_ROLES } from "../jobTransitionGuard";
import {
  ASK_FOR_DECISION_ROLES,
  COMPLETE_NEXT_STEP_ROLES,
  DECISION_MAKER_ROLES,
  MANAGER_AND_ABOVE_ROLES,
  NEXT_STEP_OWNER_ROLES,
  READ_DECISION_REQUEST_ROLES,
  RESPOND_TO_DECISION_ROLES,
} from "./roles";

// The two job role lists are copies of the job gates in the who-can-do-what
// table (action-roles.ts: editJobs, viewJobs), which functions/jobs.ts reads.

const names = (roles: readonly string[]): string[] => [...roles].sort();

describe("who may ask for a decision, and who may read one", () => {
  it("asking is whoever may create and edit jobs: editJobs in action-roles.ts", () => {
    expect(ACTION_ROLES.editJobs.gate).toHaveLength(6);
    expect(names(ASK_FOR_DECISION_ROLES)).toEqual(names(ACTION_ROLES.editJobs.gate));
  });

  it("reading is whoever may read jobs: viewJobs in action-roles.ts", () => {
    expect(ACTION_ROLES.viewJobs.gate).toHaveLength(6);
    expect(names(READ_DECISION_REQUEST_ROLES)).toEqual(names(ACTION_ROLES.viewJobs.gate));
  });

  it("the baseline user role may do neither", () => {
    expect(ASK_FOR_DECISION_ROLES).not.toContain("user");
    expect(READ_DECISION_REQUEST_ROLES).not.toContain("user");
  });
});

describe("who can be asked", () => {
  it("is whoever can open the escalation inbox, the CFO included, and never the baseline user", () => {
    expect(names(DECISION_MAKER_ROLES)).toEqual(names(ESCALATION_ROLES));
    expect(DECISION_MAKER_ROLES).toContain("cfo");
    expect(DECISION_MAKER_ROLES).not.toContain("user");
  });
});

describe("who may answer a decision request, and who may finish a next step (A2)", () => {
  it("the gate is whoever can be asked: the roles that can open the escalation inbox, never the baseline user", () => {
    expect(names(RESPOND_TO_DECISION_ROLES)).toEqual(names(DECISION_MAKER_ROLES));
    expect(names(RESPOND_TO_DECISION_ROLES)).toEqual(names(ESCALATION_ROLES));
    expect(RESPOND_TO_DECISION_ROLES).not.toContain("user");
    expect(names(COMPLETE_NEXT_STEP_ROLES)).toEqual(names(RESPOND_TO_DECISION_ROLES));
  });

  it("a next step may be handed to whoever can open the escalation inbox, where it lands", () => {
    expect(names(NEXT_STEP_OWNER_ROLES)).toEqual(names(ESCALATION_ROLES));
    expect(NEXT_STEP_OWNER_ROLES).not.toContain("user");
  });

  it("'a manager and above' is the job guard's own list (FLAG_ROLES): the managers, the CFO, directors and admin", () => {
    expect(MANAGER_AND_ABOVE_ROLES).toBe(FLAG_ROLES);
    expect(names(MANAGER_AND_ABOVE_ROLES)).toEqual(["accounts_manager", "admin", "cfo", "director", "facilities_manager"]);
    expect(MANAGER_AND_ABOVE_ROLES).not.toContain("facilities");
    expect(MANAGER_AND_ABOVE_ROLES).not.toContain("accounts");
  });

  it("every manager and above can reach the endpoint that finishes a step", () => {
    for (const role of MANAGER_AND_ABOVE_ROLES) expect(COMPLETE_NEXT_STEP_ROLES).toContain(role);
  });
});
