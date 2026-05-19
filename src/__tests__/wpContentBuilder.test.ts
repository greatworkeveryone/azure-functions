import assert from "node:assert";
import { buildWpContent, buildWpPayload } from "../wpContentBuilder";

describe("buildWpContent", () => {
  it("renders description followed by bullet list", () => {
    const html = buildWpContent("Great space.", ["Air con", "3 phase power"]);
    assert.ok(html.includes("Great space."));
    assert.ok(html.includes("<li>Air con</li>"));
    assert.ok(html.includes("<li>3 phase power</li>"));
  });

  it("omits bullet list when additionalDetails is empty", () => {
    const html = buildWpContent("Great space.", []);
    assert.ok(!html.includes("<ul>"));
  });

  it("handles null description", () => {
    const html = buildWpContent(null, ["Parking"]);
    assert.ok(html.includes("<li>Parking</li>"));
    assert.ok(!html.includes("null"));
  });

  it("returns empty string when both are empty", () => {
    const html = buildWpContent(null, []);
    assert.strictEqual(html.trim(), "");
  });
});

describe("buildWpPayload", () => {
  it("sets status to publish", () => {
    const payload = buildWpPayload("Title", "Sub", "Desc", [], 42);
    assert.strictEqual(payload.status, "publish");
  });

  it("sets featured_media from mediaId", () => {
    const payload = buildWpPayload("Title", null, null, [], 99);
    assert.strictEqual(payload.featured_media, 99);
  });

  it("sets excerpt to subtitle when provided", () => {
    const payload = buildWpPayload("Title", "Sub", null, [], null);
    assert.strictEqual(payload.excerpt, "Sub");
  });

  it("sets excerpt to empty string when subtitle is null", () => {
    const payload = buildWpPayload("Title", null, null, [], null);
    assert.strictEqual(payload.excerpt, "");
  });
});
