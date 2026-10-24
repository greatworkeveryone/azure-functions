import { parseMarkdown } from "./markdown";
import { escapeHtml, renderEmail, type RenderInput } from "./render";

const input = (markdown: string, over: Partial<RenderInput> = {}): RenderInput => ({
  blocks: parseMarkdown(markdown),
  companyAddress: null,
  companyName: "Randazzo Properties",
  receivingReason: "You are receiving this notice because you are a listed contact for a tenancy with Randazzo Properties.",
  replyTo: { address: "accounts@randazzo.properties", name: "Randazzo Accounts" },
  signature: { email: "accounts@randazzo.properties", lines: ["Accounts team"], phone: "08 8900 1111" },
  subject: "Water shut-off",
  ...over,
});

describe("renderEmail: the layout", () => {
  const email = renderEmail(input("## Planned shut-off\n\nDear Fay,\n\nWater is off **Tuesday**.\n\n- level 1\n- level 2\n\n> note\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |"));

  it("has the brand header, the body, the signature and the footer in that order", () => {
    const at = (text: string) => email.html.indexOf(text);
    expect(at("Randazzo Properties")).toBeGreaterThan(-1);
    expect(at("Planned shut-off")).toBeGreaterThan(at("Randazzo Properties"));
    expect(at("Kind regards,")).toBeGreaterThan(at("Water is off"));
    expect(at("You are receiving this notice")).toBeGreaterThan(at("Kind regards,"));
  });

  it("renders each block kind", () => {
    expect(email.html).toContain("<h2");
    expect(email.html).toContain("<strong>Tuesday</strong>");
    expect(email.html).toContain("<ul");
    expect(email.html).toContain("<hr");
    expect(email.html).toContain("<table");
    expect(email.html).toContain("border-left:3px");
  });

  it("prints the signature lines, phone and email, and the reply-to in the footer", () => {
    expect(email.html).toContain("<strong>Accounts team</strong>");
    expect(email.html).toContain("Phone 08 8900 1111");
    expect(email.html).toContain('href="mailto:accounts@randazzo.properties"');
    expect(email.html).toContain("Replies to this email go to Randazzo Accounts &lt;accounts@randazzo.properties&gt;.");
  });

  it("has a plain-text alternative with the same words", () => {
    expect(email.text).toContain("Planned shut-off");
    expect(email.text).toContain("Water is off Tuesday.");
    expect(email.text).toContain("- level 1");
    expect(email.text).toContain("Kind regards,\nAccounts team\nPhone 08 8900 1111\naccounts@randazzo.properties");
    expect(email.text).toContain("You are receiving this notice");
    expect(email.text).not.toMatch(/<\/?(p|strong|ul|li|table|h2|br)\b/);
  });

  it("shows the postal address only when one is configured, and no reason for a letter", () => {
    expect(email.html).not.toMatch(/GPO|Box/);
    const withAddress = renderEmail(input("Hi", { companyAddress: "1 Example St, Darwin NT", receivingReason: null }));
    expect(withAddress.html).toContain("1 Example St, Darwin NT");
    expect(withAddress.html).not.toContain("You are receiving");
  });
});

describe("renderEmail: nothing hidden, nothing tracked", () => {
  const html = renderEmail(input("Visit [our site](https://example.com/page?x=1) or [mail us](mailto:a@b.co).")).html;

  it("loads no images and no scripts, and rewrites no links", () => {
    expect(html).not.toMatch(/<img|<script|<iframe|<link|@import|url\(/i);
    expect(html).toContain('href="https://example.com/page?x=1"');
    expect(html).toContain('href="mailto:a@b.co"');
  });

  it("drops a link that is not http, https or mailto, keeping its words", () => {
    const rendered = renderEmail(input("[click](javascript:alert(1)) and [data](data:text/html;base64,AAAA) and [rel](/path)")).html;
    expect(rendered).not.toContain("href=\"javascript");
    expect(rendered).not.toContain("href=\"data:");
    expect(rendered).not.toContain('href="/path"');
    expect(rendered).toContain("click");
  });

  it("escapes markup in the body, the subject, the signature and a quote in an address", () => {
    const rendered = renderEmail(
      input("Hello <script>alert(1)</script> & \"quotes\"", {
        replyTo: { address: "a@b.co", name: 'Eve "<b>"' },
        signature: { email: null, lines: ["<i>Team</i>"], phone: null },
        subject: "<b>Subject</b>",
      }),
    );
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("&lt;i&gt;Team&lt;/i&gt;");
    expect(rendered.html).toContain("<title>&lt;b&gt;Subject&lt;/b&gt;</title>");
    expect(rendered.html).not.toContain('Eve "<b>"');
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});
