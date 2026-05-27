import assert from "node:assert";
import { mapGroupMembersToUsers } from "../graph";
import { mapUsersToStaff } from "../functions/staff";
import type { GraphUser } from "../graph";

// ── mapGroupMembersToUsers ───────────────────────────────────────────────────

describe("mapGroupMembersToUsers", () => {
  test("maps a valid user record to GraphUser", () => {
    const raw = [
      {
        "@odata.type": "#microsoft.graph.user",
        id: "abc-123",
        displayName: "Alice Wong",
        mail: "alice@example.com",
        mobilePhone: "0412 345 678",
      },
    ];
    const result = mapGroupMembersToUsers(raw);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "abc-123");
    assert.strictEqual(result[0].displayName, "Alice Wong");
    assert.strictEqual(result[0].mail, "alice@example.com");
    assert.strictEqual(result[0].mobilePhone, "0412 345 678");
  });

  test("filters out non-user members (nested groups)", () => {
    const raw = [
      {
        "@odata.type": "#microsoft.graph.group",
        id: "group-1",
        displayName: "Nested Group",
        mail: null,
        mobilePhone: null,
      },
      {
        "@odata.type": "#microsoft.graph.user",
        id: "user-1",
        displayName: "Bob Patel",
        mail: "bob@example.com",
        mobilePhone: null,
      },
    ];
    const result = mapGroupMembersToUsers(raw);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "user-1");
  });

  test("filters out members with missing id", () => {
    const raw = [
      {
        "@odata.type": "#microsoft.graph.user",
        id: "",
        displayName: "No Id User",
        mail: "noid@example.com",
        mobilePhone: null,
      },
      {
        "@odata.type": "#microsoft.graph.user",
        displayName: "Undefined Id User",
        mail: "undefinedid@example.com",
        mobilePhone: null,
      },
    ];
    const result = mapGroupMembersToUsers(raw);
    assert.strictEqual(result.length, 0);
  });

  test("coerces null/missing displayName to empty string", () => {
    const raw = [
      {
        "@odata.type": "#microsoft.graph.user",
        id: "user-1",
        displayName: null,
        mail: "a@example.com",
        mobilePhone: null,
      },
    ];
    const result = mapGroupMembersToUsers(raw);
    assert.strictEqual(result[0].displayName, "");
  });

  test("returns null for mail and mobilePhone when absent", () => {
    const raw = [
      {
        "@odata.type": "#microsoft.graph.user",
        id: "user-1",
        displayName: "Alice",
      },
    ];
    const result = mapGroupMembersToUsers(raw);
    assert.strictEqual(result[0].mail, null);
    assert.strictEqual(result[0].mobilePhone, null);
  });

  test("returns empty array on empty input", () => {
    assert.deepStrictEqual(mapGroupMembersToUsers([]), []);
  });
});

// ── mapUsersToStaff ──────────────────────────────────────────────────────────

describe("mapUsersToStaff", () => {
  const users: GraphUser[] = [
    { id: "1", displayName: "Zara Adams", mail: "zara@example.com", mobilePhone: null },
    { id: "2", displayName: "Alice Brown", mail: "alice@example.com", mobilePhone: null },
    { id: "3", displayName: "Bob Chen", mail: null, mobilePhone: null },
    { id: "4", displayName: "Mike Davis", mail: "mike@example.com", mobilePhone: "0400 000 000" },
  ];

  test("maps displayName → name and mail → email", () => {
    const result = mapUsersToStaff([users[0]]);
    assert.strictEqual(result[0].name, "Zara Adams");
    assert.strictEqual(result[0].email, "zara@example.com");
  });

  test("filters out users with no email", () => {
    const result = mapUsersToStaff(users);
    assert.ok(result.every((s) => s.email));
    assert.strictEqual(result.length, 3);
  });

  test("sorts alphabetically by name", () => {
    const result = mapUsersToStaff(users);
    const names = result.map((s) => s.name);
    assert.deepStrictEqual(names, ["Alice Brown", "Mike Davis", "Zara Adams"]);
  });

  test("returns empty array when all users lack email", () => {
    const noEmail: GraphUser[] = [
      { id: "1", displayName: "Ghost User", mail: null, mobilePhone: null },
    ];
    assert.deepStrictEqual(mapUsersToStaff(noEmail), []);
  });

  test("returns empty array on empty input", () => {
    assert.deepStrictEqual(mapUsersToStaff([]), []);
  });

  test("dedupes users by email (case-insensitive) when merging groups", () => {
    const overlap: GraphUser[] = [
      { id: "1", displayName: "Alice Brown", mail: "alice@example.com", mobilePhone: null },
      { id: "2", displayName: "Mike Davis",  mail: "mike@example.com",  mobilePhone: null },
      { id: "3", displayName: "Alice Brown", mail: "ALICE@example.com", mobilePhone: null },
    ];
    const result = mapUsersToStaff(overlap);
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(
      result.map((s) => s.name),
      ["Alice Brown", "Mike Davis"],
    );
  });
});
