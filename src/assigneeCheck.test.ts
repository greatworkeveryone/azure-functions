/// <reference types="jest" />
// A job goes only to someone active who has signed in; the picker hides the rest, this holds. DB mocked.
import { assigneeRefusal } from "./assigneeCheck";
import { executeQuery } from "./db";

jest.mock("./db", () => ({ executeQuery: jest.fn() }));

const query = jest.mocked(executeQuery);
const connection = { id: "connection" } as unknown as Parameters<typeof assigneeRefusal>[0];

beforeEach(() => query.mockReset());

it("accepts a signed-in, active person, asking for that person by id", async () => {
  query.mockResolvedValue([{ Hit: 1 }]);

  await expect(assigneeRefusal(connection, 7)).resolves.toBeNull();
  const [, sql, params] = query.mock.calls[0];
  expect(sql).toMatch(/FROM dbo\.AppUsers WHERE UserID = @UserID AND IsActive = 1 AND EntraOid IS NOT NULL/);
  expect(params).toEqual([expect.objectContaining({ name: "UserID", value: 7 })]);
});

it("refuses an invitee who has never signed in, or an account that is off, in words", async () => {
  query.mockResolvedValue([]);

  await expect(assigneeRefusal(connection, 21)).resolves.toEqual({
    code: "assignee_not_active",
    error: expect.stringMatching(/haven't signed in to Floorplan yet/),
  });
});
