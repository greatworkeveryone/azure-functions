/// <reference types="jest" />
import { assessSenderAuth, type MessageHeader } from "./sender-auth";

const ORG = ["randazzo.properties"];

const MS_PASS =
  "spf=pass (sender IP is 203.0.113.5) smtp.mailfrom=contractor.com.au; dkim=pass (signature was verified) " +
  "header.d=contractor.com.au;dmarc=pass action=none header.from=contractor.com.au;compauth=pass reason=100";

function ar(value: string): MessageHeader {
  return { name: "Authentication-Results", value };
}

describe("assessSenderAuth → internal mail", () => {
  const internal: MessageHeader = { name: "X-MS-Exchange-Organization-AuthAs", value: "Internal" };

  it("passes when Exchange authenticated the sender as an org user and From is an org domain", () => {
    const res = assessSenderAuth([internal], "Carlo@Randazzo.Properties", ORG);

    expect(res.authenticated).toBe(true);
    expect(res.summary).toBe("X-MS-Exchange-Organization-AuthAs: Internal");
  });

  it("matches the header name and value case-insensitively", () => {
    const res = assessSenderAuth(
      [{ name: "x-ms-exchange-organization-authas", value: " internal " }],
      "carlo@randazzo.properties",
      ORG,
    );

    expect(res.authenticated).toBe(true);
  });

  it("fails when the From domain is not one of the org's domains", () => {
    expect(assessSenderAuth([internal], "carlo@evil.example", ORG).authenticated).toBe(false);
  });

  it("fails closed when no org domains are configured", () => {
    expect(assessSenderAuth([internal], "carlo@randazzo.properties", []).authenticated).toBe(false);
  });

  it("fails on AuthAs: Anonymous (internet mail)", () => {
    const res = assessSenderAuth(
      [{ name: "X-MS-Exchange-Organization-AuthAs", value: "Anonymous" }],
      "carlo@randazzo.properties",
      ORG,
    );

    expect(res.authenticated).toBe(false);
  });

  it("fails when AuthAs appears more than once (ambiguous)", () => {
    const res = assessSenderAuth(
      [internal, { name: "X-MS-Exchange-Organization-AuthAs", value: "Anonymous" }],
      "carlo@randazzo.properties",
      ORG,
    );

    expect(res.authenticated).toBe(false);
  });

  it("fails when the cross-tenant stamp disagrees", () => {
    const res = assessSenderAuth(
      [internal, { name: "X-MS-Exchange-CrossTenant-AuthAs", value: "Anonymous" }],
      "carlo@randazzo.properties",
      ORG,
    );

    expect(res.authenticated).toBe(false);
  });

  it("reads ORG_EMAIL_DOMAINS when no domains are passed", () => {
    const prev = process.env.ORG_EMAIL_DOMAINS;
    process.env.ORG_EMAIL_DOMAINS = " Other.example , randazzo.properties ";
    try {
      expect(assessSenderAuth([internal], "carlo@randazzo.properties").authenticated).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ORG_EMAIL_DOMAINS;
      else process.env.ORG_EMAIL_DOMAINS = prev;
    }
  });
});

describe("assessSenderAuth → external mail (Authentication-Results)", () => {
  it("passes on dmarc=pass with header.from aligned to the From domain", () => {
    const res = assessSenderAuth([ar(MS_PASS)], "Quotes@Contractor.com.au", ORG);

    expect(res.authenticated).toBe(true);
    expect(res.summary).toBe(`Authentication-Results: ${MS_PASS}`);
  });

  it("fails when dmarc=pass is for a different header.from domain", () => {
    expect(assessSenderAuth([ar(MS_PASS)], "director@randazzo.properties", ORG).authenticated).toBe(false);
  });

  it("fails on dmarc=bestguesspass", () => {
    const value = "spf=pass smtp.mailfrom=contractor.com.au; dkim=none; dmarc=bestguesspass action=none header.from=contractor.com.au;";

    expect(assessSenderAuth([ar(value)], "q@contractor.com.au", ORG).authenticated).toBe(false);
  });

  it("fails on dmarc=fail", () => {
    const value = "spf=fail smtp.mailfrom=contractor.com.au; dkim=fail; dmarc=fail action=oreject header.from=contractor.com.au;";

    const res = assessSenderAuth([ar(value)], "q@contractor.com.au", ORG);

    expect(res.authenticated).toBe(false);
    expect(res.summary).toBe(`Authentication-Results: ${value}`);
  });

  it("fails with no headers at all", () => {
    expect(assessSenderAuth([], "q@contractor.com.au", ORG)).toEqual({ authenticated: false, summary: null });
  });

  it("fails with no From address", () => {
    expect(assessSenderAuth([ar(MS_PASS)], "", ORG).authenticated).toBe(false);
  });

  it("ignores ARC-Authentication-Results", () => {
    const res = assessSenderAuth(
      [{ name: "ARC-Authentication-Results", value: `i=1; mx.microsoft.com 1; ${MS_PASS}` }],
      "q@contractor.com.au",
      ORG,
    );

    expect(res.authenticated).toBe(false);
  });

  it("uses the topmost (Microsoft-added) header, not a sender-injected one below it", () => {
    const injected = "dmarc=pass action=none header.from=contractor.com.au";
    const real = "spf=fail smtp.mailfrom=contractor.com.au; dmarc=fail action=none header.from=contractor.com.au;";

    const res = assessSenderAuth([ar(real), ar(injected)], "q@contractor.com.au", ORG);

    expect(res.authenticated).toBe(false);
    expect(res.summary).toContain(real);
    expect(res.summary).toContain(injected);
  });

  it("passes when the topmost header passes, even with other results below", () => {
    const older = "spf=none; dmarc=none header.from=contractor.com.au";

    expect(assessSenderAuth([ar(MS_PASS), ar(older)], "q@contractor.com.au", ORG).authenticated).toBe(true);
  });

  it("truncates the summary to 2000 characters", () => {
    const res = assessSenderAuth([ar(`${MS_PASS} ${"x".repeat(3000)}`)], "q@contractor.com.au", ORG);

    expect(res.summary?.length).toBe(2000);
  });
});
