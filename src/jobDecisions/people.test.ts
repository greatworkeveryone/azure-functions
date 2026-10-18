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

  it("asks people of different roles", () => {
    expect(resolveDecisionMakers({ mode: "named", userIds: [3, 5, 6, 8] }, DIRECTORY, ALANA.userId).userIds).toEqual([3, 5, 6, 8]);
  });

  it("refuses an admin, in plain words (422): admin approves nothing real, so a request to them would only be answered by someone who may not", () => {
    expect(refused(() => resolveDecisionMakers({ mode: "named", userIds: [3, ADA.userId] }, DIRECTORY, ALANA.userId))).toMatchObject({
      code: "decision_maker_role_not_allowed",
      details: { userIds: [ADA.userId] },
      message: "Admin looks after Floorplan and doesn't decide on jobs, so Ada can't be asked. Ask someone else.",
      status: 422,
    });
  });

  it("names every admin it refuses, and says nothing of the inbox for them", () => {
    const BEN = user(21, "Ben", "admin");
    const error = refused(() => resolveDecisionMakers({ mode: "named", userIds: [ADA.userId, BEN.userId, 5] }, [...DIRECTORY, BEN], ALANA.userId)) as Error;
    expect(error.message).toBe("Admin looks after Floorplan and doesn't decide on jobs, so Ada, Ben can't be asked. Ask someone else.");
    expect(error.message).not.toMatch(/inbox/);
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

  // A request saved before admin could be asked (A1 fix 63523d4) still holds the role;
  // a re-ask resolves it again, and must not ask admin.
  it("refuses the admin role, in the words the request form's refusal uses, though admins are in the directory", () => {
    expect(refused(() => resolveDecisionMakers({ mode: "role", role: "admin" }, DIRECTORY, ALANA.userId))).toMatchObject({
      code: "decision_maker_role_not_allowed",
      details: { role: "admin" },
      message: "Admin looks after Floorplan and doesn't decide on jobs, so a question can't be put to the Admin role. Ask a director, the CFO or a manager.",
      status: 422,
    });
  });

  it("reads the stored role the way the request does: trimmed and lower-cased", () => {
    expect(refused(() => resolveDecisionMakers({ mode: "role", role: " Admin " }, DIRECTORY, ALANA.userId))).toMatchObject({ code: "decision_maker_role_not_allowed" });
    expect(resolveDecisionMakers({ mode: "role", role: " Director " }, DIRECTORY, ALANA.userId).userIds).toEqual([DEE.userId, ELI.userId]);
  });

  it("refuses a role that can't open the escalation inbox, so nobody in it is asked", () => {
    expect(refused(() => resolveDecisionMakers({ mode: "role", role: "user" }, DIRECTORY, ALANA.userId))).toMatchObject({ code: "bad_request", status: 400 });
    expect(refused(() => resolveDecisionMakers({ mode: "role", role: "nonsense" }, DIRECTORY, ALANA.userId))).toMatchObject({ code: "bad_request", status: 400 });
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
