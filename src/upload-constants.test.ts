import { bytesMatchMediaType, isAllowedContentType, isInlineSafeType, normaliseMediaType } from "./upload-constants";

describe("normaliseMediaType", () => {
  it("drops parameters, whitespace and case", () => {
    expect(normaliseMediaType(" Image/SVG+xml ; charset=utf-8")).toBe("image/svg+xml");
  });
});

describe("isAllowedContentType", () => {
  it.each(["image/svg+xml", "image/svg+xml; charset=utf-8", "IMAGE/SVG+XML;x=1", "text/html", "image/x-icon", "application/vnd.openxmlformats-officedocument.evil", ""])(
    "refuses %p",
    (t) => expect(isAllowedContentType(t)).toBe(false),
  );
  it.each(["image/jpeg", "image/png; foo=bar", "application/pdf", "application/msword", "text/plain", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"])(
    "accepts %p",
    (t) => expect(isAllowedContentType(t)).toBe(true),
  );
});

describe("isInlineSafeType", () => {
  it("is true only for allowlisted images and PDF", () => {
    expect(isInlineSafeType("image/png")).toBe(true);
    expect(isInlineSafeType("application/pdf")).toBe(true);
    expect(isInlineSafeType("text/plain")).toBe(false);
    expect(isInlineSafeType("image/svg+xml")).toBe(false);
  });
});

describe("bytesMatchMediaType", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  it("accepts matching signatures", () => {
    expect(bytesMatchMediaType("image/png", png)).toBe(true);
    expect(bytesMatchMediaType("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(bytesMatchMediaType("image/gif", Buffer.from("GIF89a..."))).toBe(true);
    expect(bytesMatchMediaType("application/pdf", Buffer.from("%PDF-1.7"))).toBe(true);
    expect(bytesMatchMediaType("image/webp", Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe(true);
    expect(bytesMatchMediaType("image/heic", Buffer.from("\0\0\0\x18ftypheic"))).toBe(true);
  });
  it("rejects SVG/HTML bytes declared as image or PDF", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(bytesMatchMediaType("image/png", svg)).toBe(false);
    expect(bytesMatchMediaType("image/jpeg; charset=x", svg)).toBe(false);
    expect(bytesMatchMediaType("application/pdf", svg)).toBe(false);
  });
  it("does not sniff other types", () => {
    expect(bytesMatchMediaType("text/plain", Buffer.from("anything"))).toBe(true);
  });
});
