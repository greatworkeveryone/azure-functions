import { composeSignature, parseRoleSignature, parseUserSignature, type SignatureActor } from "./signature";

const actor = (over: Partial<SignatureActor> = {}): SignatureActor => ({ email: "fay@randazzo.properties", jobTitle: "Facilities officer", name: "Fay Facilities", phone: "08 8900 0000", ...over });
const identity = { signature: { email: "facilities@randazzo.properties", lines: ["Facilities team", "Randazzo Properties"], phone: "08 8900 1111" } };

describe("composeSignature", () => {
  it("builds the team signature from the identity and nothing of the person", () => {
    const result = composeSignature(actor(), "role", identity);
    expect(result).toEqual({ ok: true, signature: { email: "facilities@randazzo.properties", lines: ["Facilities team", "Randazzo Properties"], phone: "08 8900 1111" } });
    expect(JSON.stringify(result)).not.toContain("Fay");
    expect(JSON.stringify(result)).not.toContain("0000");
  });

  it("builds the personal signature from the verified name, their title and phone, and their company address", () => {
    expect(composeSignature(actor(), "personal", identity)).toEqual({
      ok: true,
      signature: { email: "fay@randazzo.properties", lines: ["Fay Facilities", "Facilities officer"], phone: "08 8900 0000" },
    });
  });

  it("uses the person's own details even when an identity is chosen", () => {
    const result = composeSignature(actor(), "personal", identity);
    expect(JSON.stringify(result)).not.toContain("Facilities team");
  });

  it("leaves out a title, a phone or an address they don't have", () => {
    expect(composeSignature(actor({ email: "fay@gmail.com", jobTitle: null, phone: null }), "personal", null)).toEqual({
      ok: true,
      signature: { email: null, lines: ["Fay Facilities"], phone: null },
    });
  });

  it("refuses a team signature with no identity, or an identity with no signature", () => {
    expect(composeSignature(actor(), "role", null)).toMatchObject({ ok: false });
    expect(composeSignature(actor(), "role", { signature: { email: null, lines: [], phone: null } })).toMatchObject({ ok: false });
  });
});

describe("parseRoleSignature", () => {
  it("accepts 1 to 6 plain lines, a phone and an email", () => {
    expect(parseRoleSignature({ email: "A@Randazzo.Properties", lines: [" Accounts team "], phone: "08 8900 1111" })).toEqual({
      ok: true,
      value: { email: "a@randazzo.properties", lines: ["Accounts team"], phone: "08 8900 1111" },
    });
  });

  it.each([
    [{ email: null, lines: [], phone: null }],
    [{ email: null, lines: "Accounts team", phone: null }],
    [{ email: null, lines: Array(7).fill("x"), phone: null }],
    [{ email: null, lines: ["<b>Accounts</b>"], phone: null }],
    [{ email: null, lines: ["x".repeat(121)], phone: null }],
    [{ email: null, lines: ["ok"], phone: "call me maybe" }],
    [{ email: "not an email", lines: ["ok"], phone: null }],
    [{ email: null, lines: [""], phone: null }],
  ])("refuses %j", (input) => {
    expect(parseRoleSignature(input)).toMatchObject({ ok: false });
  });
});

describe("parseUserSignature", () => {
  it("accepts a title and a phone, either blank", () => {
    expect(parseUserSignature({ jobTitle: " Accounts manager ", phone: "0400 000 000" })).toEqual({ ok: true, value: { jobTitle: "Accounts manager", phone: "0400 000 000" } });
    expect(parseUserSignature({ jobTitle: "", phone: undefined })).toEqual({ ok: true, value: { jobTitle: null, phone: null } });
  });

  it.each([{ jobTitle: "<script>", phone: null }, { jobTitle: "x".repeat(81), phone: null }, { jobTitle: "ok", phone: "abc" }, { jobTitle: 7, phone: null }])("refuses %j", (input) => {
    expect(parseUserSignature(input)).toMatchObject({ ok: false });
  });
});
