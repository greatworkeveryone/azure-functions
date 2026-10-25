import { findSendByInternetMessageId } from "./sendLookup";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const connection = {} as never;

const row = (over: Record<string, unknown> = {}) => ({
  Address: "pat@example.com", BuildingId: 5, CorrespondenceId: 12, InternetMessageId: "<Msg-1@mail.example>", Kind: "broadcast", RecipientType: "tenancy",
  SentByUserId: 7, Subject: "Water shut-off", TenantId: 44, ...over,
});

beforeEach(() => jest.resetAllMocks());

describe("findSendByInternetMessageId", () => {
  it("links a reply to the send, its sender and the tenancy it went to", async () => {
    db.executeQuery.mockResolvedValue([row()]);
    expect(await findSendByInternetMessageId(connection, ["msg-1@mail.example"])).toEqual({
      buildingId: 5, jobId: null, kind: "broadcast", recipientEmail: "pat@example.com", sendId: "12", sentByUserId: 7, subject: "Water shut-off", tenancyId: 44,
    });
  });

  it("asks for each id with and without brackets, in one parameterised statement", async () => {
    db.executeQuery.mockResolvedValue([]);
    await findSendByInternetMessageId(connection, ["a@x", "<B@x>"]);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toContain("OPENJSON(@Ids)");
    expect(sql).not.toContain("a@x");
    expect(JSON.parse(params[0].value)).toEqual(["a@x", "<a@x>", "b@x", "<b@x>"]);
  });

  it("prefers the send nearest the reply when the thread names several", async () => {
    db.executeQuery.mockResolvedValue([
      row({ CorrespondenceId: 1, InternetMessageId: "<root@x>" }),
      row({ CorrespondenceId: 2, InternetMessageId: "<PARENT@x>" }),
    ]);
    expect((await findSendByInternetMessageId(connection, ["root@x", "parent@x"]))?.sendId).toBe("2");
  });

  it("returns nothing, and asks nothing, when no id is given or no row matches", async () => {
    expect(await findSendByInternetMessageId(connection, [])).toBeNull();
    expect(await findSendByInternetMessageId(connection, ["<>"])).toBeNull();
    expect(db.executeQuery).not.toHaveBeenCalled();
    db.executeQuery.mockResolvedValue([row({ InternetMessageId: "<other@x>" })]);
    expect(await findSendByInternetMessageId(connection, ["a@x"])).toBeNull();
  });

  it("leaves the tenancy, building and sender empty for a send to a contractor or by the system", async () => {
    db.executeQuery.mockResolvedValue([row({ BuildingId: null, RecipientType: "contractor", SentByUserId: null, TenantId: null })]);
    expect(await findSendByInternetMessageId(connection, ["msg-1@mail.example"])).toMatchObject({ buildingId: null, sentByUserId: null, tenancyId: null });
  });

  it("lets a failure reach the caller, which links nothing and carries on", async () => {
    db.executeQuery.mockRejectedValue(new Error("sql down"));
    await expect(findSendByInternetMessageId(connection, ["a@x"])).rejects.toThrow("sql down");
  });
});
