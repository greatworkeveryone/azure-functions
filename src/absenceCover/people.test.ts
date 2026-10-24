/// <reference types="jest" />
import { DIRECTORY, user } from "../__tests__/fixtures/absenceCover";
import { possibleCovers } from "./people";

describe("possibleCovers", () => {
  it("lists colleagues who work in the inbox, by name, with their role in words", () => {
    const people = possibleCovers(DIRECTORY, 1);
    expect(people.map((person) => person.name)).toEqual(["Ann Accounts", "Ari Accounts Manager", "Cam Cfo", "Dee Director", "Max Manager", "Mia Manager", "Sam Facilities"]);
    expect(people.find((person) => person.userId === 2)).toEqual({ name: "Max Manager", role: "facilities_manager", roleLabel: "Facilities manager", userId: 2 });
  });

  it("leaves out the person themselves, admin, and a baseline user who can do nothing with it", () => {
    const ids = possibleCovers([...DIRECTORY, user(10, "user", "Una User")], 7).map((person) => person.userId);
    expect(ids).not.toContain(7);
    expect(ids).not.toContain(9);
    expect(ids).not.toContain(10);
  });
});
