import { loadStaff, STAFF_ROLES } from "./load";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const connection = {} as never;

beforeEach(() => jest.resetAllMocks());

describe("loadStaff", () => {
  it("asks for active, signed-in people in a staff role, plus the extra person in any role", async () => {
    db.executeQuery.mockResolvedValue([{ DisplayName: "Fay", Role: "facilities", UserID: 1 }, { DisplayName: "Dee", Role: null, UserID: 4 }]);
    expect(await loadStaff(connection, 4)).toEqual([{ name: "Fay", role: "facilities", userId: 1 }, { name: "Dee", role: "", userId: 4 }]);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    // An invitee has no EntraOid until their first sign-in and is never handed mail.
    expect(sql).toMatch(/IsActive = 1 AND EntraOid IS NOT NULL AND \(Role IN \(/);
    for (const role of STAFF_ROLES) expect(sql).toContain(`'${role}'`);
    expect(sql).toContain("OR UserID = @Extra");
    expect(params).toEqual([expect.objectContaining({ name: "Extra", value: 4 })]);
  });
});
