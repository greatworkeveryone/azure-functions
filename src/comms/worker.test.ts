import { MailSendError, type MailSender } from "./graphSend";
import type { RecipientOutcome } from "./queueQueries";
import type { JobRow, QueueItem, RecipientRow, RecipientStatus } from "./types";
import { RETRY_WAIT_MINUTES, runCommsQueue, type QueueStore, type WorkerOptions } from "./worker";

const NOW = new Date("2026-10-24T03:00:00Z");

const job = (over: Partial<JobRow> = {}): JobRow => ({
  approvedAt: null, approvedByName: null, approvedByOid: null, blockedCount: 0,
  bodyMarkdown: "Dear {{tenant.name}},\n\nWater is off.",
  cancelledAt: null, cancelledByName: null, completedAt: null, correspondenceId: 1, createdAt: "2026-10-24T00:00:00.000Z",
  createdByEmail: "fay@randazzo.properties", createdByName: "Fay Facilities", createdByOid: "fay-oid", createdByRole: "facilities",
  failedCount: 0, fromAddress: "notices@randazzo.properties", fromName: "Randazzo Properties", kind: "broadcast",
  queuedAt: "2026-10-24T00:00:00.000Z", recipientCount: 1, replyToAddress: "facilities@randazzo.properties", replyToIdentityId: 3,
  replyToName: "Randazzo Facilities", requiresApproval: false, rowVersion: "00", sentCount: 0,
  signature: { email: null, lines: ["Facilities team"], phone: null }, signatureMode: "role", status: "queued", subject: "Water shut-off",
  templateId: null, templateVersion: null,
  ...over,
});

let nextId = 100;
const recipient = (over: Partial<RecipientRow> = {}): RecipientRow => ({
  address: `pat${nextId}@example.com`, attempts: 0, correspondenceId: 1, detail: null, graphMessageId: null, internetMessageId: null,
  lastAttemptAt: null, lastErrorCode: null, mergeValues: { "tenant.name": "Acme" }, name: "Pat", nextAttemptAt: null, recipientId: nextId++,
  recipientRefId: "7", recipientType: "tenancy", sentAt: null, sentToAddress: null, status: "queued",
  ...over,
});

interface Fake extends QueueStore {
  calls: string[];
  items: QueueItem[];
  jobStatus: Record<number, string>;
  outcomes: { from: RecipientStatus; id: number; outcome: RecipientOutcome }[];
  recent: number;
  settled: number[];
  stale: number[];
  /** Recipients the server's records say are not the stored contact, by recipient id. */
  mismatched: Set<number>;
  resolved: RecipientRow[];
  testContacts: Set<string>;
  testTenancies: Set<number>;
}

function fakeStore(items: QueueItem[]): Fake {
  const fake: Fake = {
    calls: [], items, jobStatus: { 1: "queued" }, outcomes: [], recent: 0, settled: [], stale: [], mismatched: new Set(), resolved: [], testContacts: new Set(), testTenancies: new Set(),
    async claim(id) {
      fake.calls.push(`claim:${id}`);
      const item = fake.items.find((entry) => entry.recipient.recipientId === id);
      if (!item || !["queued", "would_send"].includes(item.recipient.status) || !["queued", "sending"].includes(fake.jobStatus[item.job.correspondenceId])) return false;
      item.recipient = { ...item.recipient, attempts: item.recipient.attempts + 1, status: "sending" };
      return true;
    },
    // Stands for the server's own records: only the stored type, id and address are asked, never anything from the request.
    async resolve(recipientRow) {
      fake.resolved.push(recipientRow);
      if (recipientRow.recipientType === "tenancy" && !/^[1-9]\d*$/.test(recipientRow.recipientRefId ?? "")) return { code: "unknown_record", detail: "No such record to send to", ok: false };
      if (recipientRow.recipientType === "tenancy" && fake.testTenancies.has(Number(recipientRow.recipientRefId))) return { code: "test_record", detail: "That tenancy is a test record", ok: false };
      if (recipientRow.recipientType === "manual" && fake.testContacts.has(recipientRow.address)) return { code: "test_record", detail: "That address belongs to a test record", ok: false };
      if (fake.mismatched.has(recipientRow.recipientId)) return { code: "address_mismatch", detail: "That address isn't the recorded contact for that record", ok: false };
      return { ok: true };
    },
    async markJobSending(id) { fake.calls.push(`job-sending:${id}`); fake.jobStatus[id] = "sending"; },
    async outcome(item, from, outcome) {
      fake.outcomes.push({ from, id: item.recipient.recipientId, outcome });
      const target = fake.items.find((entry) => entry.recipient.recipientId === item.recipient.recipientId)!;
      target.recipient = { ...target.recipient, status: outcome.status, graphMessageId: outcome.graphMessageId ?? target.recipient.graphMessageId, internetMessageId: outcome.internetMessageId ?? target.recipient.internetMessageId, lastErrorCode: outcome.errorCode ?? null, nextAttemptAt: outcome.nextAttemptAt?.toISOString() ?? null };
      return true;
    },
    async readQueue(limit, live) {
      fake.calls.push(`read:${limit}:${live}`);
      return fake.items.filter((entry) => entry.recipient.status === "queued" || (live && entry.recipient.status === "would_send")).slice(0, limit);
    },
    async recentAttempts() { return fake.recent; },
    async recoverStale() { return fake.stale; },
    async saveDraft(id, graphId, internetId) {
      fake.calls.push(`draft-saved:${id}:${graphId}`);
      const target = fake.items.find((entry) => entry.recipient.recipientId === id)!;
      target.recipient = { ...target.recipient, graphMessageId: graphId, internetMessageId: internetId };
    },
    async settle(id) { fake.settled.push(id); },
  };
  return fake;
}

interface FakeSender extends MailSender {
  drafts: { subject: string; to: string; html: string; replyTo: { address: string; name: string | null }; from: { address: string; name: string } }[];
  sends: string[];
}

function fakeSender(over: { draft?: () => Promise<{ graphMessageId: string; internetMessageId: string | null }>; send?: (id: string) => Promise<void> } = {}): FakeSender {
  let n = 0;
  const sender: FakeSender = {
    drafts: [], sends: [],
    async createDraft(input) {
      sender.drafts.push(input);
      return over.draft ? over.draft() : { graphMessageId: `graph-${++n}`, internetMessageId: `<msg-${n}@randazzo.properties>` };
    },
    async sendDraft(_from, id) {
      sender.sends.push(id);
      if (over.send) await over.send(id);
    },
    async sendWithoutCopy() {},
  };
  return sender;
}

const run = (store: Fake, sender: MailSender, over: Partial<WorkerOptions> = {}) =>
  runCommsQueue({ fromAddress: "notices@randazzo.properties", log: jest.fn(), maxPerMinute: 25, mode: "live", now: () => NOW, sender, store, ...over });

const item = (recipientOver: Partial<RecipientRow> = {}, jobOver: Partial<JobRow> = {}): QueueItem => ({ job: job(jobOver), recipient: recipient(recipientOver) });

beforeEach(() => {
  delete process.env.DEV_EMAIL_OVERRIDE;
});

describe("off", () => {
  it("does nothing and touches neither the database nor Graph", async () => {
    const store = fakeStore([item()]);
    const sender = fakeSender();
    const report = await run(store, sender, { mode: "off" });
    expect(report).toMatchObject({ mode: "off", sent: 0, taken: 0 });
    expect(store.calls).toEqual([]);
    expect(sender.drafts).toEqual([]);
    expect(store.items[0].recipient.status).toBe("queued");
  });
});

describe("the sender", () => {
  it("holds a job queued under any address but the configured sender, calling nothing", async () => {
    const store = fakeStore([item({}, { fromAddress: "accounts@randazzo.properties" }), item()]);
    const sender = fakeSender();
    const report = await run(store, sender);
    expect(report).toMatchObject({ blocked: 1, sent: 1 });
    expect(store.outcomes[0].outcome).toMatchObject({ errorCode: "sender_mismatch", status: "blocked" });
    expect(sender.drafts.map((draft) => draft.from.address)).toEqual(["notices@randazzo.properties"]);
  });

  it("compares addresses without regard to case or spaces", async () => {
    const store = fakeStore([item({}, { fromAddress: " Notices@Randazzo.Properties " })]);
    const report = await run(store, fakeSender());
    expect(report).toMatchObject({ blocked: 0, sent: 1 });
  });
});

describe("dry run", () => {
  it("composes, logs and marks each recipient would-send, and never calls Graph", async () => {
    const log = jest.fn();
    const store = fakeStore([item(), item()]);
    const sender = fakeSender();
    const report = await run(store, sender, { log, mode: "dry-run" });
    expect(report).toMatchObject({ mode: "dry-run", taken: 2, wouldSend: 2, sent: 0 });
    expect(store.items.map((entry) => entry.recipient.status)).toEqual(["would_send", "would_send"]);
    expect(store.outcomes.map((entry) => entry.outcome.status)).toEqual(["would_send", "would_send"]);
    expect(sender.drafts).toEqual([]);
    expect(sender.sends).toEqual([]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toMatch(/would send job 1 recipient/);
    expect(store.calls.some((call) => call.startsWith("claim"))).toBe(false);
    expect(store.calls).toContain("read:25:false");
  });

  it("does not read a recipient it already marked, so the next minute adds nothing", async () => {
    const store = fakeStore([item()]);
    const sender = fakeSender();
    await run(store, sender, { mode: "dry-run" });
    const second = await run(store, sender, { mode: "dry-run" });
    expect(second.taken).toBe(0);
  });

  it("goes live later: a would-send recipient is sent once the dry run is off", async () => {
    const store = fakeStore([item()]);
    const sender = fakeSender();
    await run(store, sender, { mode: "dry-run" });
    expect(sender.sends).toEqual([]);
    const live = await run(store, sender, { mode: "live" });
    expect(live.sent).toBe(1);
    expect(sender.sends).toEqual(["graph-1"]);
  });

  it("still blocks a recipient with a missing field, and a test record, in a dry run", async () => {
    const store = fakeStore([item({ mergeValues: {} }), item({ recipientRefId: "9" })]);
    store.testTenancies.add(9);
    const report = await run(store, fakeSender(), { mode: "dry-run" });
    expect(report).toMatchObject({ blocked: 2, wouldSend: 0 });
  });
});

describe("a live send", () => {
  it("makes the draft from the one sender with the reply-to, keeps both ids, sends it and records the outcome", async () => {
    const store = fakeStore([item()]);
    const sender = fakeSender();
    const report = await run(store, sender);
    expect(report).toMatchObject({ sent: 1, taken: 1 });
    expect(sender.drafts).toHaveLength(1);
    expect(sender.drafts[0]).toMatchObject({
      from: { address: "notices@randazzo.properties", name: "Randazzo Properties" },
      replyTo: { address: "facilities@randazzo.properties", name: "Randazzo Facilities" },
      subject: "Water shut-off",
    });
    expect(sender.drafts[0].html).toContain("Facilities team");
    expect(sender.sends).toEqual(["graph-1"]);
    expect(store.outcomes).toHaveLength(1);
    expect(store.outcomes[0]).toMatchObject({ from: "sending", outcome: { graphMessageId: "graph-1", internetMessageId: "<msg-1@randazzo.properties>", status: "sent" } });
    expect(store.settled).toEqual([1]);
  });

  it("saves the draft's ids before it sends, so a failed send keeps them", async () => {
    const store = fakeStore([item()]);
    const order: string[] = [];
    store.saveDraft = async (id, graphId) => { order.push(`saved:${graphId}`); };
    const sender = fakeSender({ send: async () => { order.push("sent"); } });
    await run(store, sender);
    expect(order).toEqual(["saved:graph-1", "sent"]);
  });

  it("sends one message per recipient, each to its own address only", async () => {
    const store = fakeStore([item({ address: "a@example.com" }), item({ address: "b@example.com" }), item({ address: "c@example.com" })]);
    const sender = fakeSender();
    await run(store, sender);
    expect(sender.drafts.map((draft) => draft.to)).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
  });

  it("merges each recipient's own values", async () => {
    const store = fakeStore([item({ mergeValues: { "tenant.name": "Alpha Pty" } }), item({ mergeValues: { "tenant.name": "Beta Pty" } })]);
    const sender = fakeSender();
    await run(store, sender);
    expect(sender.drafts[0].html).toContain("Dear Alpha Pty,");
    expect(sender.drafts[1].html).toContain("Dear Beta Pty,");
  });

  it("reuses the draft it already made when a retry comes, instead of making a second message", async () => {
    const store = fakeStore([item({ attempts: 1, graphMessageId: "graph-existing", internetMessageId: "<old@x>" })]);
    const sender = fakeSender();
    await run(store, sender);
    expect(sender.drafts).toEqual([]);
    expect(sender.sends).toEqual(["graph-existing"]);
    expect(store.outcomes[0].outcome).toMatchObject({ graphMessageId: "graph-existing", status: "sent" });
  });

  it("keeps an over-long internet message id out of the index but still marks the message sent", async () => {
    const store = fakeStore([item()]);
    const sender = fakeSender({ draft: async () => ({ graphMessageId: "g", internetMessageId: `<${"x".repeat(900)}>` }) });
    await run(store, sender);
    expect(store.outcomes[0].outcome).toMatchObject({ internetMessageId: null, status: "sent" });
  });

  it("skips a recipient another run took first, and sends nothing for it", async () => {
    const store = fakeStore([item()]);
    store.claim = async () => false;
    const sender = fakeSender();
    const report = await run(store, sender);
    expect(report).toMatchObject({ skipped: 1, sent: 0 });
    expect(sender.drafts).toEqual([]);
  });

  it("does not send to a job cancelled between the read and the claim", async () => {
    const store = fakeStore([item()]);
    store.jobStatus[1] = "cancelled";
    const sender = fakeSender();
    expect(await run(store, sender)).toMatchObject({ skipped: 1 });
    expect(sender.drafts).toEqual([]);
  });

  it("marks the job sending when the first message goes", async () => {
    const store = fakeStore([item()]);
    await run(store, fakeSender());
    expect(store.calls).toContain("job-sending:1");
  });
});

describe("throttle", () => {
  const many = (count: number) => Array.from({ length: count }, () => item());

  it("sends at most COMMS_MAX_PER_MINUTE a run, oldest first, and leaves the rest queued", async () => {
    const store = fakeStore(many(7));
    const sender = fakeSender();
    const report = await run(store, sender, { maxPerMinute: 3 });
    expect(report).toMatchObject({ budget: 3, sent: 3, taken: 3 });
    expect(store.items.map((entry) => entry.recipient.status)).toEqual(["sent", "sent", "sent", "queued", "queued", "queued", "queued"]);
    expect(sender.sends).toHaveLength(3);
  });

  it("takes off what the last minute already used, so overlapping runs share the budget", async () => {
    const store = fakeStore(many(7));
    store.recent = 2;
    const report = await run(store, fakeSender(), { maxPerMinute: 3 });
    expect(report).toMatchObject({ budget: 1, sent: 1 });
  });

  it("sends nothing when the minute is used up, and reads nothing", async () => {
    const store = fakeStore(many(3));
    store.recent = 3;
    const report = await run(store, fakeSender(), { maxPerMinute: 3 });
    expect(report).toMatchObject({ budget: 0, sent: 0, taken: 0 });
    expect(store.calls.some((call) => call.startsWith("read"))).toBe(false);
  });
});

describe("retry", () => {
  it("puts a retryable failure back in the queue with a wait, recording the code only", async () => {
    const store = fakeStore([item()]);
    const sender = fakeSender({ send: async () => { throw new MailSendError("graph_throttled", true, 429); } });
    const report = await run(store, sender);
    expect(report).toMatchObject({ retried: 1, sent: 0 });
    const outcome = store.outcomes[0].outcome;
    expect(outcome).toMatchObject({ errorCode: "graph_throttled", status: "queued" });
    expect(outcome.nextAttemptAt?.getTime()).toBe(NOW.getTime() + RETRY_WAIT_MINUTES[0] * 60_000);
    expect(JSON.stringify(outcome)).not.toMatch(/429|Graph|Bearer/);
  });

  it("waits longer after the second failure", async () => {
    const store = fakeStore([item({ attempts: 1, graphMessageId: "g1" })]);
    const sender = fakeSender({ send: async () => { throw new MailSendError("graph_unavailable", true, 503); } });
    await run(store, sender);
    expect(store.outcomes[0].outcome.nextAttemptAt?.getTime()).toBe(NOW.getTime() + RETRY_WAIT_MINUTES[1] * 60_000);
  });

  it("fails for good after the third attempt", async () => {
    const store = fakeStore([item({ attempts: 2, graphMessageId: "g1" })]);
    const sender = fakeSender({ send: async () => { throw new MailSendError("graph_unavailable", true, 503); } });
    const report = await run(store, sender);
    expect(report).toMatchObject({ failed: 1, retried: 0 });
    expect(store.outcomes[0].outcome).toMatchObject({ errorCode: "graph_unavailable", status: "failed" });
  });

  it("fails at once, with no retry, for an error trying again can't fix", async () => {
    const store = fakeStore([item()]);
    const sender = fakeSender({ draft: async () => { throw new MailSendError("graph_rejected", false, 400); } });
    expect(await run(store, sender)).toMatchObject({ failed: 1 });
    expect(store.outcomes[0].outcome).toMatchObject({ errorCode: "graph_rejected", status: "failed" });
  });

  it("never sends a draft twice: a send that finds its draft gone is failed as unconfirmed", async () => {
    const store = fakeStore([item({ attempts: 1, graphMessageId: "g1" })]);
    const sender = fakeSender({ send: async () => { throw new MailSendError("send_unconfirmed", false, 404); } });
    await run(store, sender);
    expect(store.outcomes[0].outcome).toMatchObject({ errorCode: "send_unconfirmed", status: "failed" });
  });

  it("turns an unexpected error into a network code, never its text", async () => {
    const store = fakeStore([item()]);
    const sender = fakeSender({ draft: async () => { throw new Error("connect ECONNRESET 20.1.2.3:443 token=abc"); } });
    await run(store, sender);
    expect(store.outcomes[0].outcome).toMatchObject({ errorCode: "network", status: "queued" });
    expect(JSON.stringify(store.outcomes)).not.toContain("ECONNRESET");
  });

  it("settles the job after every run so a finished job completes", async () => {
    const store = fakeStore([item()]);
    await run(store, fakeSender());
    expect(store.settled).toEqual([1]);
  });
});

describe("fail closed", () => {
  it("blocks a recipient whose merge field is blank, names it, and calls nothing", async () => {
    const store = fakeStore([item({ mergeValues: {} })]);
    const sender = fakeSender();
    const report = await run(store, sender);
    expect(report).toMatchObject({ blocked: 1, sent: 0 });
    expect(store.outcomes[0].outcome).toMatchObject({ detail: "Missing: Tenant name", errorCode: "missing_field", status: "blocked" });
    expect(sender.drafts).toEqual([]);
  });
});

describe("the egress guard: test records never leave", () => {
  it("blocks a tenancy recipient tied to a test record, live and with no Graph call", async () => {
    const store = fakeStore([item({ recipientRefId: "9" }), item({ recipientRefId: "10" })]);
    store.testTenancies.add(9);
    const sender = fakeSender();
    const report = await run(store, sender);
    expect(report).toMatchObject({ blocked: 1, sent: 1 });
    expect(store.outcomes[0].outcome).toMatchObject({ errorCode: "test_record", status: "blocked" });
    expect(sender.drafts).toHaveLength(1);
    expect(sender.drafts[0].to).not.toBe(store.items[0].recipient.address);
  });

  it("blocks a tenancy recipient whose id is not a number rather than guess", async () => {
    const store = fakeStore([item({ recipientRefId: null })]);
    const sender = fakeSender();
    expect(await run(store, sender)).toMatchObject({ blocked: 1 });
    expect(sender.drafts).toEqual([]);
  });

  it("blocks an address that is not the record's stored contact, whatever the request called it, and sends nothing", async () => {
    const store = fakeStore([item({ address: "someone-else@example.com" }), item()]);
    store.mismatched.add(store.items[0].recipient.recipientId);
    const sender = fakeSender();
    const report = await run(store, sender);
    expect(report).toMatchObject({ blocked: 1, sent: 1 });
    expect(store.outcomes[0].outcome).toMatchObject({ detail: "That address isn't the recorded contact for that record", errorCode: "address_mismatch", status: "blocked" });
    expect(sender.drafts.map((draft) => draft.to)).not.toContain("someone-else@example.com");
  });

  it("blocks a typed address that is a test record's contact, and does not call it a tenancy", async () => {
    const store = fakeStore([item({ address: "test.contact@example.com", recipientRefId: null, recipientType: "manual" })]);
    store.testContacts.add("test.contact@example.com");
    const sender = fakeSender();
    expect(await run(store, sender)).toMatchObject({ blocked: 1, sent: 0 });
    expect(store.outcomes[0].outcome).toMatchObject({ detail: "That address belongs to a test record", errorCode: "test_record", status: "blocked" });
    expect(sender.drafts).toEqual([]);
  });

  it("asks the server's resolution about every recipient, whatever its type, before anything is sent", async () => {
    const store = fakeStore([item({ recipientRefId: "5" }), item({ recipientRefId: "6", recipientType: "contractor" }), item({ recipientRefId: "7", recipientType: "staff" }), item({ recipientRefId: null, recipientType: "manual" })]);
    const sender = fakeSender();
    expect(await run(store, sender)).toMatchObject({ sent: 4 });
    expect(store.resolved.map((row) => row.recipientType)).toEqual(["tenancy", "contractor", "staff", "manual"]);
  });

  it("never sends to a recipient the server can't resolve to a record", async () => {
    const store = fakeStore([item({ recipientRefId: "abc" })]);
    const sender = fakeSender();
    expect(await run(store, sender)).toMatchObject({ blocked: 1 });
    expect(store.outcomes[0].outcome).toMatchObject({ errorCode: "unknown_record", status: "blocked" });
    expect(sender.drafts).toEqual([]);
  });
});

describe("DEV_EMAIL_OVERRIDE", () => {
  it("sends every recipient to the override address instead, and says who it was meant for", async () => {
    process.env.DEV_EMAIL_OVERRIDE = "dev@randazzo.properties";
    const store = fakeStore([item({ address: "tenant1@example.com" }), item({ address: "tenant2@example.com" })]);
    const sender = fakeSender();
    await run(store, sender);
    expect(sender.drafts.map((draft) => draft.to)).toEqual(["dev@randazzo.properties", "dev@randazzo.properties"]);
    expect(sender.drafts[0].subject).toBe("[For tenant1@example.com] Water shut-off");
    expect(store.outcomes[0].outcome).toMatchObject({ sentToAddress: "dev@randazzo.properties", status: "sent" });
  });

  it("redirects a dry run's would-send record too", async () => {
    process.env.DEV_EMAIL_OVERRIDE = "dev@randazzo.properties";
    const store = fakeStore([item({ address: "tenant1@example.com" })]);
    await run(store, fakeSender(), { mode: "dry-run" });
    expect(store.outcomes[0].outcome).toMatchObject({ sentToAddress: "dev@randazzo.properties", status: "would_send" });
  });

  it("changes nothing when it is unset", async () => {
    const store = fakeStore([item({ address: "tenant1@example.com" })]);
    const sender = fakeSender();
    await run(store, sender);
    expect(sender.drafts[0]).toMatchObject({ subject: "Water shut-off", to: "tenant1@example.com" });
  });
});

describe("a run that died", () => {
  it("settles the jobs whose interrupted recipients were recovered", async () => {
    const store = fakeStore([]);
    store.stale = [5, 6];
    const report = await run(store, fakeSender());
    expect(report.recovered).toBe(2);
    expect(store.settled.sort()).toEqual([5, 6]);
  });

  it("does not recover anything in a dry run", async () => {
    const store = fakeStore([]);
    store.stale = [5];
    expect((await run(store, fakeSender(), { mode: "dry-run" })).recovered).toBe(0);
  });
});
