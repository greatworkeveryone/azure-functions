/// <reference types="jest" />
// Who may answer a decision request, and who may finish a next step (jobs plan A2). Pure.
import { responderStanding, stepStanding } from "./standing";

const named = (userIds: number[], requestedByUserId: number | null = 9) =>
  ({ assignmentMode: "named", decisionMakers: { role: null, userIds }, requestedByUserId }) as const;
const roleWide = (role: string, userIds: number[], requestedByUserId: number | null = 9) =>
  ({ assignmentMode: "role", decisionMakers: { role, userIds }, requestedByUserId }) as const;

describe("a request put to named people", () => {
  const request = named([3, 5]);

  it("is answered by each of them, and says it was as one of the people named", () => {
    expect(responderStanding(request, { roles: ["accounts_manager"], userId: 3 })).toEqual({ allowed: true, via: "named" });
    expect(responderStanding(request, { roles: ["director"], userId: 5 })).toEqual({ allowed: true, via: "named" });
  });

  it("is not answered by anyone else, whatever their role: a director who was not asked is not a decision-maker", () => {
    for (const roles of [["director"], ["admin"], ["accounts_manager"], ["cfo"]]) {
      expect(responderStanding(request, { roles, userId: 6 })).toMatchObject({ allowed: false, code: "not_named" });
    }
  });

  it("says who it was put to, when it is told their names", () => {
    const standing = responderStanding(request, { roles: ["facilities"], userId: 8 }, ["Cam", "Dee"]);
    expect(standing).toMatchObject({ allowed: false, message: "This question was put to Cam, Dee. You weren't asked, so you can't answer it." });
  });

  it("gives a plain reason without the names", () => {
    expect(responderStanding(request, { roles: ["facilities"], userId: 8 })).toMatchObject({ message: expect.stringMatching(/put to particular people/) });
  });

  it("is not answered by someone with no user id, even holding the right role", () => {
    expect(responderStanding(request, { roles: ["accounts_manager"], userId: null })).toMatchObject({ allowed: false, code: "not_named" });
  });
});

describe("a request put to everyone in a role", () => {
  const request = roleWide("accounts_manager", [3, 4]);

  it("is answered by whoever holds the role now, including someone given it since the question was asked", () => {
    expect(responderStanding(request, { roles: ["accounts_manager"], userId: 3 })).toEqual({ allowed: true, via: "role" });
    // 30 was not in the role when it was asked (userIds is who was), and holds it now.
    expect(responderStanding(request, { roles: ["accounts_manager"], userId: 30 })).toEqual({ allowed: true, via: "role" });
  });

  it("is not answered by someone who was in the role when it was asked and has left it", () => {
    expect(responderStanding(request, { roles: ["facilities"], userId: 4 })).toMatchObject({ allowed: false, code: "not_in_role" });
  });

  it("reads the role however it is written, and any one of several held", () => {
    expect(responderStanding(request, { roles: [" Accounts_Manager "], userId: 30 })).toMatchObject({ allowed: true });
    expect(responderStanding(request, { roles: ["facilities", "accounts_manager"], userId: 30 })).toMatchObject({ allowed: true });
  });

  it("does not take a senior role for the role: a director or the CFO is not an accounts manager, and admin is not anyone's", () => {
    for (const role of ["director", "cfo", "admin", "accounts"]) {
      expect(responderStanding(request, { roles: [role], userId: 31 })).toMatchObject({ allowed: false, code: "not_in_role" });
    }
  });

  it("names the role in the reason", () => {
    expect(responderStanding(request, { roles: ["facilities"], userId: 8 })).toMatchObject({
      message: "This question was put to everyone in the Accounts manager role. You don't hold that role, so you can't answer it.",
    });
  });
});

describe("the person who asked", () => {
  it("never answers their own question, named or by role, even if they hold the role it was put to now", () => {
    expect(responderStanding(named([3]), { roles: ["accounts_manager"], userId: 9 })).toMatchObject({ allowed: false, code: "asker" });
    expect(responderStanding(roleWide("accounts_manager", [3]), { roles: ["accounts_manager"], userId: 9 })).toMatchObject({
      allowed: false,
      code: "asker",
      message: "You asked this question, so someone else has to answer it.",
    });
    // and even listed (which asking refuses, but the rule does not depend on it)
    expect(responderStanding(named([9, 3]), { roles: ["accounts"], userId: 9 })).toMatchObject({ allowed: false, code: "asker" });
  });

  it("does not shut out everyone when the request has no recorded asker", () => {
    expect(responderStanding(named([3], null), { roles: ["accounts_manager"], userId: 3 })).toMatchObject({ allowed: true });
    expect(responderStanding(roleWide("accounts_manager", [], null), { roles: ["accounts_manager"], userId: null })).toMatchObject({ allowed: true });
  });
});

describe("admin", () => {
  // Admin cannot be asked any more (roles.ts), so a request naming admin is one from
  // before that, or written by hand. Admin approves nothing real (decision 4): it may
  // answer only on a test job.
  const askedAdmin = named([3, 7]);
  const askedAdminByRole = roleWide("admin", [7]);

  it("named on a real job, may not answer: refused with its own code and a plain reason", () => {
    expect(responderStanding(askedAdmin, { roles: ["admin"], userId: 7 })).toEqual({
      allowed: false,
      code: "admin_test_jobs_only",
      message: "Admin answers questions on test jobs only. This is a real job, so someone else has to answer it.",
    });
  });

  it("a real job is the default: a responder who says nothing about the job gets the same refusal", () => {
    expect(responderStanding(askedAdmin, { roles: ["admin"], testJob: false, userId: 7 })).toMatchObject({ allowed: false, code: "admin_test_jobs_only" });
  });

  it("put to the admin role on a real job, may not answer either", () => {
    expect(responderStanding(askedAdminByRole, { roles: ["admin"], userId: 7 })).toMatchObject({ allowed: false, code: "admin_test_jobs_only" });
  });

  it("named on a test job, may answer, as one of the people named", () => {
    expect(responderStanding(askedAdmin, { roles: ["admin"], testJob: true, userId: 7 })).toEqual({ allowed: true, via: "named" });
    expect(responderStanding(askedAdminByRole, { roles: ["admin"], testJob: true, userId: 7 })).toEqual({ allowed: true, via: "role" });
  });

  it("a test job does not make admin everyone's stand-in: not named is still not named", () => {
    expect(responderStanding(named([3]), { roles: ["admin"], testJob: true, userId: 7 })).toMatchObject({ allowed: false, code: "not_named" });
  });

  it("admin who asked the question is still told so, test job or not", () => {
    expect(responderStanding(named([3], 7), { roles: ["admin"], testJob: true, userId: 7 })).toMatchObject({ allowed: false, code: "asker" });
  });

  it("a person who holds admin and a working role answers as that role does, as for money (adminRefusal)", () => {
    expect(responderStanding(named([3, 5]), { roles: ["admin", "director"], userId: 5 })).toEqual({ allowed: true, via: "named" });
  });

  it("the test flag changes nothing for anyone else", () => {
    expect(responderStanding(named([5]), { roles: ["director"], testJob: false, userId: 5 })).toEqual({ allowed: true, via: "named" });
    expect(responderStanding(named([5]), { roles: ["director"], testJob: true, userId: 5 })).toEqual({ allowed: true, via: "named" });
    expect(responderStanding(named([5]), { roles: ["director"], testJob: true, userId: 6 })).toMatchObject({ allowed: false, code: "not_named" });
  });
});

describe("who may finish a next step", () => {
  const forAlana = { nextStepOwnerRole: null, nextStepOwnerUserId: 9 };
  const forRole = { nextStepOwnerRole: "accounts", nextStepOwnerUserId: null };

  it("the person it was handed to may", () => {
    expect(stepStanding(forAlana, { roles: ["accounts"], userId: 9 })).toEqual({ allowed: true, as: "owner" });
  });

  it("anyone who holds the role it was handed to now may", () => {
    expect(stepStanding(forRole, { roles: ["accounts"], userId: 40 })).toEqual({ allowed: true, as: "role" });
    expect(stepStanding(forRole, { roles: [" ACCOUNTS "], userId: 41 })).toMatchObject({ allowed: true, as: "role" });
  });

  it("a manager and above may finish anyone's step: the managers, the CFO, directors and admin", () => {
    for (const role of ["accounts_manager", "facilities_manager", "cfo", "director", "admin"]) {
      expect(stepStanding(forAlana, { roles: [role], userId: 50 })).toEqual({ allowed: true, as: "manager" });
    }
  });

  it("a colleague at the owner's own level may not", () => {
    for (const role of ["accounts", "facilities"]) {
      expect(stepStanding(forAlana, { roles: [role], userId: 50 })).toMatchObject({ allowed: false });
    }
    expect(stepStanding(forRole, { roles: ["facilities"], userId: 50 })).toMatchObject({ allowed: false });
  });

  it("explains whose it is, by name or by role", () => {
    expect(stepStanding(forAlana, { roles: ["facilities"], userId: 50 }, "Alana")).toEqual({
      allowed: false,
      message: "This step was handed to Alana. Only they, or a manager, can mark it done.",
    });
    expect(stepStanding(forRole, { roles: ["facilities"], userId: 50 })).toMatchObject({
      message: "This step was handed to everyone in the Accounts role. Only they, or a manager, can mark it done.",
    });
    expect(stepStanding(forAlana, { roles: ["facilities"], userId: 50 })).toMatchObject({ message: expect.stringContaining("someone else") });
  });

  it("does not treat a missing user id as the owner", () => {
    expect(stepStanding({ nextStepOwnerRole: null, nextStepOwnerUserId: null }, { roles: ["accounts"], userId: null })).toMatchObject({ allowed: false });
  });
});
