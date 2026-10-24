import { composeForRecipient, dateText, longDate, receivingReason, type ComposeJob } from "./compose";

const job = (over: Partial<ComposeJob> = {}): ComposeJob => ({
  bodyMarkdown: "Dear {{tenant.addressee}},\n\nSigned {{sender.name}}, {{sender.title}}. {{today}} / {{today.long}}.",
  companyName: "Randazzo Properties",
  createdByName: "Fay Facilities",
  kind: "broadcast",
  replyTo: { address: "fay@randazzo.properties", name: "Fay Facilities" },
  signature: { email: "fay@randazzo.properties", lines: ["Fay Facilities", "Facilities officer"], phone: null },
  signatureMode: "personal",
  subject: "Hello {{recipient.name}}",
  ...over,
});
const recipient = { mergeValues: { "tenant.name": "Acme" }, name: "Pat", recipientType: "tenancy" as const };
const now = new Date("2026-10-24T03:00:00Z");

describe("composeForRecipient", () => {
  it("fills the server's own fields (sender, today in Darwin, recipient name) and renders", () => {
    const result = composeForRecipient(job(), recipient, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.email.subject).toBe("Hello Pat");
    expect(result.email.text).toContain("Signed Fay Facilities, Facilities officer. 24/10/2026 / 24 October 2026.");
    expect(result.email.text).toContain("Dear Acme,");
  });

  it("uses Darwin's date: 14:30 UTC on the 24th is already the 25th there", () => {
    const result = composeForRecipient(job(), recipient, new Date("2026-10-24T15:00:00Z"));
    expect(result.ok && result.email.text).toContain("25/10/2026");
  });

  it("ignores a client value for a field the server fills", () => {
    const result = composeForRecipient(job(), { ...recipient, mergeValues: { ...recipient.mergeValues, "sender.name": "Someone Else" } }, now);
    expect(result.ok && result.email.text).not.toContain("Someone Else");
  });

  it("blocks a recipient whose value is missing, and names the field", () => {
    const result = composeForRecipient(job(), { ...recipient, mergeValues: {} }, now);
    expect(result).toMatchObject({ detail: "Missing: Name for the greeting", ok: false });
  });

  it("blocks a team-signature email that asks for the sender's title, which a team signature doesn't carry", () => {
    const result = composeForRecipient(job({ signatureMode: "role", signature: { email: null, lines: ["Facilities team"], phone: null } }), recipient, now);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.detail).toContain("Sender title");
  });

  it("blocks an email with no wording", () => {
    expect(composeForRecipient(job({ bodyMarkdown: "  " }), recipient, now)).toMatchObject({ detail: "The email has no wording", ok: false });
  });
});

describe("the wording around the email", () => {
  it("says why a notice reached each kind of recipient, and nothing for a letter", () => {
    expect(receivingReason("broadcast", "tenancy")).toContain("listed contact for a tenancy");
    expect(receivingReason("broadcast", "contractor")).toContain("contractor registered");
    expect(receivingReason("broadcast", "staff")).toContain("work with");
    expect(receivingReason("broadcast", "manual")).toContain("addressed it to you");
    expect(receivingReason("letter", "tenancy")).toBeNull();
  });

  it("writes dates DD/MM/YYYY and in full", () => {
    expect(dateText("2026-01-05")).toBe("05/01/2026");
    expect(longDate("2026-01-05")).toBe("5 January 2026");
  });
});
