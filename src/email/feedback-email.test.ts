/// <reference types="jest" />
import {
  buildFeedbackEmail,
  getFeedbackRecipients,
  isFeedbackTopic,
  sanitiseLine,
} from "./feedback-email";
import type { FeedbackEmailInput } from "./feedback-email";

const SENDER = { email: "sarah.chen@randazzo.properties", name: "Sarah Chen" };
const SENT_AT = new Date("2026-08-13T15:30:00Z"); // 14/08 01:00 in Darwin, still 13/08 in UTC

function input(overrides: Partial<FeedbackEmailInput> = {}): FeedbackEmailInput {
  return {
    body: "The rent review date is a year out.",
    customTopic: null,
    sender: SENDER,
    sentAt: SENT_AT,
    topic: "data",
    url: "https://app.example.com/tenancy?tenancyId=118",
    userAgent: "Mozilla/5.0 (iPhone)",
    viewport: "390 × 844",
    ...overrides,
  };
}

describe("isFeedbackTopic", () => {
  it("accepts the five known topics", () => {
    expect(isFeedbackTopic("bug")).toBe(true);
    expect(isFeedbackTopic("data")).toBe(true);
    expect(isFeedbackTopic("design")).toBe(true);
    expect(isFeedbackTopic("feature")).toBe(true);
    expect(isFeedbackTopic("other")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isFeedbackTopic("urgent")).toBe(false);
    expect(isFeedbackTopic("")).toBe(false);
  });
});

describe("getFeedbackRecipients", () => {
  const original = process.env.FEEDBACK_EMAIL_RECIPIENTS;
  afterEach(() => {
    // Assigning `undefined` to a process.env property coerces it to the
    // string "undefined", which would leak into every other test file in
    // this Jest worker (src/functions/feedback.test.ts reads this exact var).
    if (original === undefined) delete process.env.FEEDBACK_EMAIL_RECIPIENTS;
    else process.env.FEEDBACK_EMAIL_RECIPIENTS = original;
  });

  it("splits, trims and drops blanks", () => {
    process.env.FEEDBACK_EMAIL_RECIPIENTS = " connor@example.com , will@example.com ,";
    expect(getFeedbackRecipients()).toEqual(["connor@example.com", "will@example.com"]);
  });

  it("splits on semicolons as well as commas", () => {
    process.env.FEEDBACK_EMAIL_RECIPIENTS = "connor@example.com; will@example.com";
    expect(getFeedbackRecipients()).toEqual(["connor@example.com", "will@example.com"]);
  });

  it("drops entries that don't look like an email address", () => {
    process.env.FEEDBACK_EMAIL_RECIPIENTS = "connor@example.com, not-an-email";
    expect(getFeedbackRecipients()).toEqual(["connor@example.com"]);
  });

  it("returns an empty array when every entry is junk", () => {
    process.env.FEEDBACK_EMAIL_RECIPIENTS = "not-an-email, also-bad";
    expect(getFeedbackRecipients()).toEqual([]);
  });

  it("returns an empty array when unset", () => {
    delete process.env.FEEDBACK_EMAIL_RECIPIENTS;
    expect(getFeedbackRecipients()).toEqual([]);
  });
});

describe("sanitiseLine", () => {
  it("collapses CR/LF so a client cannot forge extra footer lines", () => {
    expect(sanitiseLine("https://app/x\r\nFrom: admin@evil.com", 500)).toBe(
      "https://app/x From: admin@evil.com",
    );
  });

  it("collapses every UAX #14 mandatory line break, plus TAB, to a single space", () => {
    // U+000B (VT), U+000C (FF), U+0085 (NEL), U+2028 (LS), U+2029 (PS) are all
    // mandatory breaks under UAX #14. TAB isn't a line break but would let a
    // caller fake the footer's column alignment, so it collapses the same way.
    // Built via fromCodePoint rather than typed literally, so the test file
    // itself never carries an invisible/control character.
    const breakCodePoints = [0x0b, 0x0c, 0x85, 0x2028, 0x2029, 0x09];
    breakCodePoints.forEach((codePoint) => {
      const breakChar = String.fromCodePoint(codePoint);
      expect(sanitiseLine(`a${breakChar}b`, 500)).toBe("a b");
    });
  });

  it("strips zero-width and bidi-override characters", () => {
    // U+200B (ZWSP) and U+202E (RTL override) are invisible in a mail client
    // but can hide or reorder text — stripped entirely rather than spaced.
    const zwsp = String.fromCodePoint(0x200b);
    const rtlOverride = String.fromCodePoint(0x202e);
    expect(sanitiseLine(`a${zwsp}b${rtlOverride}c`, 500)).toBe("abc");
  });

  it("truncates past the limit with an ellipsis", () => {
    expect(sanitiseLine("abcdefghij", 4)).toBe("abcd…");
  });

  it("truncates on code points, not UTF-16 units, so a surrogate pair is never split", () => {
    const thumbsUp = String.fromCodePoint(0x1f44d); // 👍 — a supplementary-plane
    // character encoded as a UTF-16 surrogate pair; slice() would cut it in half.
    expect(sanitiseLine(`abc${thumbsUp}def`, 4)).toBe(`abc${thumbsUp}…`);
  });
});

describe("buildFeedbackEmail", () => {
  it("uses the topic label in the subject and the first body line", () => {
    const email = buildFeedbackEmail(input());
    expect(email.subject).toBe("[Floorplan feedback] Data looks wrong — Sarah Chen");
    expect(email.body.split("\n")[0]).toBe("Data looks wrong");
  });

  it("substitutes the custom topic when the topic is 'other'", () => {
    const email = buildFeedbackEmail(
      input({ customTopic: "Printer keeps jamming", topic: "other" }),
    );
    expect(email.subject).toBe("[Floorplan feedback] Printer keeps jamming — Sarah Chen");
    expect(email.body.split("\n")[0]).toBe("Printer keeps jamming");
  });

  it("falls back to the 'Other' label when the topic is 'other' with no custom text", () => {
    const email = buildFeedbackEmail(input({ customTopic: null, topic: "other" }));
    expect(email.subject).toBe("[Floorplan feedback] Other — Sarah Chen");
  });

  it("falls back to the 'Other' label when customTopic is whitespace-only", () => {
    const email = buildFeedbackEmail(input({ customTopic: "   ", topic: "other" }));
    expect(email.subject).toBe("[Floorplan feedback] Other — Sarah Chen");
  });

  it("ignores customTopic when the topic is not 'other'", () => {
    const email = buildFeedbackEmail(input({ customTopic: "Printer keeps jamming", topic: "data" }));
    expect(email.subject).toBe("[Floorplan feedback] Data looks wrong — Sarah Chen");
    expect(email.body.split("\n")[0]).toBe("Data looks wrong");
  });

  it("carries the sender, page, date and browser in the footer", () => {
    const email = buildFeedbackEmail(input());
    expect(email.body).toContain("From:     Sarah Chen <sarah.chen@randazzo.properties>");
    expect(email.body).toContain("Page:     https://app.example.com/tenancy?tenancyId=118");
    expect(email.body).toContain("Browser:  Mozilla/5.0 (iPhone)");
    expect(email.body).toContain("Viewport: 390 × 844");
  });

  it("formats the sent date as dd/MM/yyyy, h:mm am/pm in Darwin time", () => {
    const email = buildFeedbackEmail(input());
    // Darwin is UTC+9:30, so this UTC instant is already the next day there.
    // Asserting the rolled-over date is what makes a dropped timeZone option
    // fail; asserting the full time is what makes a dropped hour or minute
    // option fail. hour12 is NOT independently covered — verified by removing
    // it that en-AU already defaults to a 12-hour clock on this runtime, so
    // the option is currently a no-op here (kept in the source anyway: it's
    // the honest expression of intent and isn't guaranteed across ICU
    // versions/locales). Confirmed on Node 22 (ICU builtin):
    // "14/08/2026, 1:00 am", using a plain space before "am" (not the narrow
    // no-break space some ICU builds use) — re-check this literal if the
    // runtime's ICU changes.
    expect(email.body).toContain("Sent:     14/08/2026, 1:00 am");
    expect(email.body).not.toContain("13/08/2026");
  });

  it("sanitises the url and user agent", () => {
    const email = buildFeedbackEmail(
      input({ url: "https://app/x\nFrom: fake@evil.com", userAgent: "UA\r\ninjected" }),
    );
    expect(email.body).toContain("Page:     https://app/x From: fake@evil.com");
    expect(email.body).not.toMatch(/^From: fake@evil\.com$/m);
    expect(email.body).toContain("Browser:  UA injected");
  });

  it("applies each length cap at its own call site", () => {
    const email = buildFeedbackEmail(
      input({
        customTopic: "c".repeat(200),
        topic: "other",
        url: `https://app.example.com/${"u".repeat(600)}`,
        userAgent: "a".repeat(400),
        viewport: "9".repeat(60),
      }),
    );

    // Caps differ per field — a swapped constant at any call site fails here.
    // url is "https://app.example.com/" (24 chars) + 600 u's = 624 chars, capped
    // at MAX_URL_CHARS (500): the 500 code points kept are the 24-char prefix
    // plus 476 u's.
    expect(email.body).toContain(`Page:     https://app.example.com/${"u".repeat(476)}…`);
    expect(email.body).toContain(`Browser:  ${"a".repeat(300)}…`);
    // viewport is 60 9's, capped at MAX_VIEWPORT_CHARS (40).
    expect(email.body).toContain(`Viewport: ${"9".repeat(40)}…`);
    expect(email.subject).toBe(`[Floorplan feedback] ${"c".repeat(80)}… — Sarah Chen`);
  });
});
