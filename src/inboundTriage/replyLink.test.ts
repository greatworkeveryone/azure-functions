import { linkedSendFor, linkReplies, storeLink } from "./replyLink";
import { findSendByInternetMessageId } from "./sendLookup";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("./sendLookup", () => ({ findSendByInternetMessageId: jest.fn() }));

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const lookup = jest.mocked(findSendByInternetMessageId);
const connection = {} as never;
const SEND = { buildingId: null, jobId: 7, kind: "correspondence", recipientEmail: null, sendId: "c-9", sentByUserId: 3, subject: "Your job", tenancyId: 4 };

beforeEach(() => {
  jest.clearAllMocks();
  lookup.mockResolvedValue(null);
});

describe("linking a reply to the send it answers", () => {
  it("asks the send core by the reply's ancestors, References first and In-Reply-To last", async () => {
    lookup.mockResolvedValue(SEND);
    expect(await linkedSendFor(connection, { inReplyTo: "parent@x", referenceIds: "root@x parent@x" })).toBe(SEND);
    expect(lookup).toHaveBeenCalledWith(connection, ["root@x", "parent@x"]);
  });

  it("asks nothing when the email names no ancestor", async () => {
    expect(await linkedSendFor(connection, { inReplyTo: null, referenceIds: null })).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("with the send core's stub answering nothing, a reply is simply unlinked", async () => {
    db.executeQuery.mockResolvedValue([{ EmailID: 1, InReplyTo: "p@x", ReferenceIds: null }]);
    expect(await linkReplies(connection, ["<m1@x>"])).toBe(0);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });

  it("links each stored reply that the send core recognises, and only those not already linked", async () => {
    db.executeQuery.mockResolvedValueOnce([{ EmailID: 1, InReplyTo: "p@x", ReferenceIds: null }, { EmailID: 2, InReplyTo: "q@x", ReferenceIds: null }]).mockResolvedValue([]);
    lookup.mockResolvedValueOnce(SEND).mockResolvedValueOnce(null);
    expect(await linkReplies(connection, ["<m1@x>", "<m2@x>"])).toBe(1);

    const [, selectSql, selectParams] = db.executeQuery.mock.calls[0];
    expect(selectSql).toContain("AND LinkedSendId IS NULL");
    expect(JSON.parse(selectParams[0].value)).toEqual(["<m1@x>", "<m2@x>"]);
    const [, updateSql, updateParams] = db.executeQuery.mock.calls[1];
    expect(updateSql).toContain("WHERE EmailID = @EmailId AND LinkedSendId IS NULL");
    expect(Object.fromEntries(updateParams.map((p: { name: string; value: unknown }) => [p.name, p.value]))).toMatchObject({ EmailId: 1, Kind: "correspondence", SendId: "c-9", Subject: "Your job" });
  });

  it("does not touch the database when there is nothing to link", async () => {
    expect(await linkReplies(connection, [])).toBe(0);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("clips what it stores to its columns", async () => {
    await storeLink(connection, 1, { ...SEND, kind: "k".repeat(80), sendId: "s".repeat(100), subject: "x".repeat(500) });
    const params = Object.fromEntries(db.executeQuery.mock.calls[0][2].map((p: { name: string; value: unknown }) => [p.name, p.value]));
    expect([String(params.Kind).length, String(params.SendId).length, String(params.Subject).length]).toEqual([30, 64, 300]);
  });
});

describe("the send lookup EB1 will replace", () => {
  it("answers nothing today", async () => {
    const real = jest.requireActual("./sendLookup") as { findSendByInternetMessageId: typeof findSendByInternetMessageId };
    expect(await real.findSendByInternetMessageId(connection, ["a@x"])).toBeNull();
  });
});
