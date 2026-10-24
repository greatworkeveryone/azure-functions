import { parseContent, parsePreviewInput, parseQueueInput, parseRecipient, SIGNATURE_REFUSAL, unexpectedKey, wholeId } from "./request";

const recipient = { address: "Pat@Example.com", name: "Pat", recipientRefId: 12, recipientType: "tenancy", mergeValues: { "tenant.name": "Acme" } };
const content = { bodyMarkdown: "Dear {{tenant.name}}", kind: "broadcast", replyTo: { identityId: 3, type: "identity" }, signatureMode: "role", subject: "Notice" };
const queue = (over: Record<string, unknown> = {}) => ({ ...content, recipients: [recipient], ...over });

describe("parseQueueInput: a valid request", () => {
  it("normalises and returns the recipients", () => {
    const parsed = parseQueueInput(queue());
    expect(parsed).toMatchObject({ ok: true, value: { kind: "broadcast", replyTo: { identityId: 3, kind: "identity" }, signatureMode: "role", subject: "Notice" } });
    if (parsed.ok) expect(parsed.value.recipients[0]).toEqual({ address: "pat@example.com", mergeValues: { "tenant.name": "Acme" }, name: "Pat", recipientRefId: "12", recipientType: "tenancy" });
  });

  it("drops a repeated address (any case) and says how many", () => {
    const parsed = parseQueueInput(queue({ recipients: [recipient, { ...recipient, address: "PAT@example.com" }, { ...recipient, address: "other@example.com", recipientRefId: 13 }] }));
    expect(parsed.ok && parsed.value.recipients.map((r) => r.address)).toEqual(["pat@example.com", "other@example.com"]);
    expect(parsed.ok && parsed.value.duplicatesDropped).toBe(1);
  });

  it("accepts the sender's own address as the reply-to", () => {
    expect(parseQueueInput(queue({ replyTo: { type: "own" }, signatureMode: "personal" }))).toMatchObject({ ok: true, value: { replyTo: { kind: "own" } } });
  });
});

describe("a request can't carry a signature, a sender or another person's details", () => {
  it.each([
    ["signature", { signature: "Kind regards, the CEO" }],
    ["signatureText", { signatureText: "x" }],
    ["signatureHtml", { signatureHtml: "<b>x</b>" }],
    ["signatureLines", { signatureLines: ["x"] }],
    ["senderName", { senderName: "Someone Else" }],
    ["fromAddress", { fromAddress: "ceo@randazzo.properties" }],
    ["fromName", { fromName: "CEO" }],
    ["jobTitle", { jobTitle: "Director" }],
    ["phone", { phone: "0400 000 000" }],
    ["footer", { footer: "x" }],
    ["html", { html: "<p>x</p>" }],
    ["replyToAddress", { replyToAddress: "boss@randazzo.properties" }],
  ])("refuses %s at the top level with the signature reason", (_name, extra) => {
    expect(parseQueueInput(queue(extra))).toEqual({ error: SIGNATURE_REFUSAL, ok: false });
    expect(parsePreviewInput({ ...content, recipient, ...extra })).toEqual({ error: SIGNATURE_REFUSAL, ok: false });
  });

  it("refuses an address, a name or an email inside replyTo", () => {
    for (const replyTo of [{ address: "boss@randazzo.properties", type: "own" }, { name: "Boss", type: "own" }, { email: "boss@randazzo.properties", identityId: 3, type: "identity" }]) {
      expect(parseQueueInput(queue({ replyTo }))).toMatchObject({ error: expect.stringContaining("can't name another address"), ok: false });
    }
  });

  it("refuses signature-like keys on a recipient", () => {
    expect(parseRecipient({ ...recipient, signature: "x" })).toEqual({ error: SIGNATURE_REFUSAL, ok: false });
    expect(parseRecipient({ ...recipient, senderTitle: "x" })).toEqual({ error: SIGNATURE_REFUSAL, ok: false });
  });

  it("refuses merge values for the sender, the date and the recipient's name: the server fills them", () => {
    for (const path of ["sender.name", "sender.title", "today", "today.long", "recipient.name"]) {
      expect(parseRecipient({ ...recipient, mergeValues: { [path]: "x" } })).toMatchObject({ error: expect.stringContaining("filled in by Floorplan"), ok: false });
    }
  });

  it("refuses an unrecognised key that isn't signature-like with its own message", () => {
    expect(unexpectedKey({ colour: "red" }, ["kind"])).toBe('Unknown field "colour"');
  });
});

describe("invalid input", () => {
  it.each([
    ["no kind", { kind: undefined }],
    ["a system kind", { kind: "system" }],
    ["a blank subject", { subject: "  " }],
    ["a subject with markup", { subject: "<b>x</b>" }],
    ["a subject that is too long", { subject: "x".repeat(201) }],
    ["no wording", { bodyMarkdown: " " }],
    ["wording that is too long", { bodyMarkdown: "x".repeat(50_001) }],
    ["a template with no version", { templateId: "rent-notice" }],
    ["a bad template version", { templateId: "rent-notice", templateVersion: 0 }],
    ["a field Floorplan doesn't have", { bodyMarkdown: "Dear {{tenant.shoeSize}}" }],
    ["no reply-to", { replyTo: undefined }],
    ["a reply-to of neither kind", { replyTo: { type: "someone" } }],
    ["an identity reply-to with no id", { replyTo: { type: "identity" } }],
    ["a bad signature mode", { signatureMode: "custom" }],
    ["no recipients", { recipients: [] }],
    ["recipients that aren't a list", { recipients: "pat@example.com" }],
    ["a recipient that isn't an object", { recipients: ["pat@example.com"] }],
    ["a bad address", { recipients: [{ ...recipient, address: "pat" }] }],
    ["a display-name address", { recipients: [{ ...recipient, address: "Pat <pat@example.com>" }] }],
    ["a list of addresses", { recipients: [{ ...recipient, address: "a@b.co, c@d.co" }] }],
    ["a bad recipient type", { recipients: [{ ...recipient, recipientType: "alien" }] }],
    ["a tenancy with no id", { recipients: [{ ...recipient, recipientRefId: undefined }] }],
    ["a tenancy with a non-numeric id", { recipients: [{ ...recipient, recipientRefId: "abc" }] }],
    ["an unknown merge field", { recipients: [{ ...recipient, mergeValues: { "tenant.shoeSize": "9" } }] }],
    ["a non-text merge value", { recipients: [{ ...recipient, mergeValues: { "tenant.name": 5 } }] }],
    ["a merge value that is too long", { recipients: [{ ...recipient, mergeValues: { "tenant.name": "x".repeat(501) } }] }],
  ])("refuses %s", (_name, over) => {
    expect(parseQueueInput(queue(over))).toMatchObject({ ok: false });
  });

  it("refuses more recipients than a send may have", () => {
    const many = Array.from({ length: 2001 }, (_, i) => ({ ...recipient, address: `p${i}@example.com`, recipientRefId: i + 1 }));
    expect(parseQueueInput(queue({ recipients: many }))).toMatchObject({ error: expect.stringContaining("at most 2000"), ok: false });
  });

  it("allows a contractor with no reference id, and a template with a version", () => {
    expect(parseQueueInput(queue({ recipients: [{ address: "c@example.com", recipientType: "contractor" }], templateId: "rent-notice", templateVersion: 2 }))).toMatchObject({
      ok: true,
      value: { templateId: "rent-notice", templateVersion: 2 },
    });
  });
});

describe("a subject is one line", () => {
  it("folds line breaks into spaces, so a subject can't add a header", () => {
    expect(parseQueueInput(queue({ subject: "Notice\r\nBcc: x@y.com" }))).toMatchObject({ ok: true, value: { subject: "Notice Bcc: x@y.com" } });
  });
});

describe("parsePreviewInput", () => {
  it("takes a draft with one recipient", () => {
    expect(parsePreviewInput({ ...content, recipient })).toMatchObject({ ok: true, value: { kind: "draft" } });
  });

  it("takes a saved send and recipient", () => {
    expect(parsePreviewInput({ correspondenceId: 4, recipientId: 9 })).toEqual({ ok: true, value: { correspondenceId: 4, kind: "saved", recipientId: 9 } });
  });

  it("refuses a draft with no recipient, a saved one with a bad id, and extra keys", () => {
    expect(parsePreviewInput({ ...content })).toMatchObject({ ok: false });
    expect(parsePreviewInput({ correspondenceId: "4", recipientId: 9 })).toMatchObject({ ok: false });
    expect(parsePreviewInput({ correspondenceId: 4, recipientId: 9, subject: "x" })).toMatchObject({ ok: false });
  });

  it("parseContent alone refuses a missing kind", () => {
    expect(parseContent({})).toMatchObject({ ok: false });
  });
});

describe("wholeId", () => {
  it.each([[7, 7], ["7", 7], ["0", null], [-1, null], ["1.5", null], [1.5, null], ["abc", null], [null, null], [undefined, null], [3_000_000_000, null]])("%j -> %j", (value, expected) => {
    expect(wholeId(value)).toBe(expected);
  });
});
