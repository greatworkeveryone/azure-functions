/// <reference types="jest" />
import type { Connection } from "tedious";
import { queueTemplatedLetter, type TemplatedLetter } from "./templated";

jest.mock("./queueJob", () => ({
  applyResolutions: jest.fn(async (_c: unknown, checked: unknown) => checked),
  checkRecipients: jest.fn(),
  isBlocked: jest.fn((entry: { blocked?: boolean }) => entry.blocked === true),
  writeJob: jest.fn(async () => ({ correspondenceId: 41, status: "queued" })),
}));
const queue = require("./queueJob") as Record<"checkRecipients" | "writeJob", jest.Mock>;

const conn = {} as Connection;
const letter = (over: Partial<TemplatedLetter> = {}): TemplatedLetter => ({
  actor: { email: "a@x.test", name: "Ann", oid: "o1", role: "facilities", roles: ["facilities"] } as TemplatedLetter["actor"],
  commsLive: false,
  key: "k1",
  kind: "letter",
  recipients: [{ address: "t@x.test", mergeValues: {}, name: "Tess", recipientRefId: null, recipientType: "manual" }],
  replyTo: { address: "r@x.test", identityId: null, name: null },
  signature: { email: null, lines: [], phone: null },
  signatureMode: "role",
  template: { approved: true, bodyMarkdown: "Hi", subject: "S", version: 3 },
  templateId: "t_id",
  userId: 7,
  ...over,
});
const entry = (blocked: boolean, extra: Record<string, unknown> = {}) => ({ blocked, composed: { ok: true }, recipient: { address: "t@x.test", name: "Tess" }, ...extra });

beforeEach(() => jest.clearAllMocks());

describe("queueTemplatedLetter", () => {
  it("queues the job with the template's version, the key and the user, and names who it went to", async () => {
    queue.checkRecipients.mockReturnValue([entry(false)]);
    const out = await queueTemplatedLetter(conn, letter());
    expect(out).toEqual({ correspondenceId: 41, ok: true, recipients: "Tess <t@x.test>", status: "queued" });
    const [, job, , , userId, , key] = queue.writeJob.mock.calls[0];
    expect(job).toMatchObject({ subject: "S", templateId: "t_id", templateVersion: 3 });
    expect([userId, key]).toEqual([7, "k1"]);
  });

  it("refuses an unapproved template only while sends are live, writing nothing", async () => {
    queue.checkRecipients.mockReturnValue([entry(false)]);
    const template = { approved: false, bodyMarkdown: "Hi", subject: "S", version: 1 };
    expect(await queueTemplatedLetter(conn, letter({ commsLive: true, template }))).toMatchObject({ code: "unapproved", ok: false });
    expect(queue.writeJob).not.toHaveBeenCalled();
    expect((await queueTemplatedLetter(conn, letter({ commsLive: false, template }))).ok).toBe(true);
  });

  it("refuses with the first reason when every recipient is blocked", async () => {
    queue.checkRecipients.mockReturnValue([entry(true, { refusal: { detail: "test tenancy" } })]);
    expect(await queueTemplatedLetter(conn, letter())).toEqual({ code: "blocked", detail: "test tenancy", ok: false });
    expect(queue.writeJob).not.toHaveBeenCalled();
  });
});
