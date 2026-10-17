/// <reference types="jest" />
import type { DirectoryUser } from "../escalation/types";
import { resolveDecisionMakers } from "./people";

const user = (userId: number, name: string, role: string): DirectoryUser => ({ email: `${name.toLowerCase()}@example.com`, name, role, userId });
const CAM = user(3, "Cam", "accounts_manager");
const KIRSTIN = user(4, "Kirstin", "accounts_manager");
const DEE = user(5, "Dee", "director");
const ELI = user(6, "Eli", "director");
const ADA = user(7, "Ada", "admin");
const FAY = user(8, "Fay", "facilities");
const ALANA = user(9, "Alana", "accounts");
const UNA = user(20, "Una", "user");
const DIRECTORY = [CAM, KIRSTIN, DEE, ELI, ADA, FAY, ALANA, UNA];

const refused = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
};

describe("naming people", () => {
  it("asks exactly the people named, in the order named", () => {
    const makers = resolveDecisionMakers({ mode: "named", userIds: [5, 3, 4] }, DIRECTORY, ALANA.userId);
    expect(makers.userIds).toEqual([5, 3, 4]);
    expect(makers.people.map((p) => p.name)).toEqual(["Dee", "Cam", "Kirstin"]);
    expect(makers.role).toBeNull();
  });

  it("asks people of different roles, an admin included", () => {
    expect(resolveDecisionMakers({ mode: "named", userIds: [3, 5, 7, 8] }, DIRECTORY, ALANA.userId).userIds).toEqual([3, 5, 7, 8]);
  });

  it("refuses someone who is not an active user, naming them (422)", () => {
    expect(refused(() => resolveDecisionMakers({ mode: "named", userIds: [3, 99, 98] }, DIRECTORY, ALANA.userId))).toMatchObject({
      code: "decision_maker_unknown",
      details: { userIds: [99, 98] },
      message: expect.stringContaining("#99, #98"),
      status: 422,
    });
  });

  it("refuses the person who is asking: they would only be asking themselves", () => {
    expect(refused(() => resolveDecisionMakers({ mode: "named", userIds: [3, ALANA.userId] }, DIRECTORY, ALANA.userId))).toMatchObject({
      code: "decision_maker_is_requester",
      status: 422,
    });
  });

  it("refuses someone whose role can't open the escalation inbox, so a request to them would never be seen", () => {
    expect(refused(() => resolveDecisionMakers({ mode: "named", userIds: [3, UNA.userId] }, DIRECTORY, ALANA.userId))).toMatchObject({
      code: "decision_maker_role_not_allowed",
      details: { userIds: [UNA.userId] },
      message: expect.stringContaining("Una"),
      status: 422,
    });
  });

  it("does not mind who is asking when the asker has no Floorplan user id", () => {
    expect(resolveDecisionMakers({ mode: "named", userIds: [3] }, DIRECTORY, null).userIds).toEqual([3]);
  });
});

describe("asking everyone in a role", () => {
  it("asks each active person in it, by name, and records the role", () => {
    const makers = resolveDecisionMakers({ mode: "role", role: "accounts_manager" }, DIRECTORY, ALANA.userId);
    expect(makers.role).toBe("accounts_manager");
    expect(makers.people.map((p) => p.name)).toEqual(["Cam", "Kirstin"]);
    expect(makers.userIds).toEqual([3, 4]);
  });

  it("leaves out the person asking when they are in the role", () => {
    const makers = resolveDecisionMakers({ mode: "role", role: "director" }, DIRECTORY, DEE.userId);
    expect(makers.userIds).toEqual([ELI.userId]);
  });

  it("refuses a role with nobody else in it (422)", () => {
    expect(refused(() => resolveDecisionMakers({ mode: "role", role: "director" }, [DEE], DEE.userId))).toMatchObject({
      code: "role_has_no_one",
      message: "There is nobody else in the Director role to ask.",
      status: 422,
    });
    expect(refused(() => resolveDecisionMakers({ mode: "role", role: "cfo" }, DIRECTORY, ALANA.userId))).toMatchObject({ code: "role_has_no_one" });
  });
});
