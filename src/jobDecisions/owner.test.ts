/// <reference types="jest" />
// Who a next step is handed to (jobs plan A2). Pure.
import type { DirectoryUser } from "../escalation/types";
import { resolveNextStepOwner } from "./owner";

const user = (userId: number, name: string, role: string): DirectoryUser => ({ email: `${name.toLowerCase()}@example.com`, name, role, userId });
const CAM = user(3, "Cam", "accounts_manager");
const DEE = user(5, "Dee", "director");
const FAY = user(8, "Fay", "facilities");
const ALANA = user(9, "Alana", "accounts");
const GUS = user(10, "Gus", "accounts");
const UNA = user(20, "Una", "user");
const DIRECTORY = [CAM, DEE, FAY, ALANA, GUS, UNA];

const refused = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
};

describe("the default owner is the person who raised the job", () => {
  it("hands the step to them, and the ladder is theirs: their manager is who it moves up to", () => {
    expect(resolveNextStepOwner(null, DIRECTORY, ALANA)).toEqual({
      kind: "user",
      ladder: { role: "accounts", userId: 9 },
      members: [ALANA],
      name: "Alana",
      role: null,
      userId: 9,
    });
  });

  it("says so when they cannot be found, rather than guessing (422)", () => {
    expect(refused(() => resolveNextStepOwner(null, DIRECTORY, null))).toMatchObject({ code: "next_step_owner_required", status: 422 });
  });

  it("will not hand a step to a creator who could never see it (a baseline user)", () => {
    expect(refused(() => resolveNextStepOwner(null, DIRECTORY, UNA))).toMatchObject({ code: "next_step_owner_role_not_allowed", status: 422 });
  });
});

describe("a named person", () => {
  it("gets the step, with their own role for the ladder", () => {
    const owner = resolveNextStepOwner({ kind: "user", userId: 8 }, DIRECTORY, ALANA);
    expect(owner).toMatchObject({ kind: "user", ladder: { role: "facilities", userId: 8 }, name: "Fay", userId: 8 });
    expect(owner.members).toEqual([FAY]);
  });

  it("may be a decision-maker handing it to themselves: any person who can open the inbox", () => {
    expect(resolveNextStepOwner({ kind: "user", userId: 5 }, DIRECTORY, ALANA)).toMatchObject({ ladder: { role: "director", userId: 5 }, name: "Dee" });
  });

  it("is refused if they are not an active user (422 next_step_owner_unknown), naming the id", () => {
    expect(refused(() => resolveNextStepOwner({ kind: "user", userId: 99 }, DIRECTORY, ALANA))).toMatchObject({
      code: "next_step_owner_unknown",
      details: { userId: 99 },
      status: 422,
    });
  });

  it("is refused if their role cannot open the escalation inbox, so the step would never be seen", () => {
    expect(refused(() => resolveNextStepOwner({ kind: "user", userId: 20 }, DIRECTORY, ALANA))).toMatchObject({
      code: "next_step_owner_role_not_allowed",
      details: { userId: 20 },
      status: 422,
    });
  });
});

describe("a role", () => {
  it("is handed to everyone who holds it now, by name, with the role's own manager as the ladder", () => {
    const owner = resolveNextStepOwner({ kind: "role", role: "accounts" }, DIRECTORY, null);
    expect(owner).toMatchObject({ kind: "role", ladder: { role: "accounts", userId: null }, name: "Accounts", role: "accounts", userId: null });
    expect(owner.members.map((member) => member.name)).toEqual(["Alana", "Gus"]);
  });

  it("is refused when nobody holds it (422 next_step_owner_role_empty)", () => {
    expect(refused(() => resolveNextStepOwner({ kind: "role", role: "cfo" }, DIRECTORY, ALANA))).toMatchObject({
      code: "next_step_owner_role_empty",
      details: { role: "cfo" },
      status: 422,
    });
  });
});
