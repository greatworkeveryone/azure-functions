import { sanitizeBlobExtension } from "../blob-storage";

// Minted blob names must always satisfy the addAttachment validator in
// inspections.ts (`inspections/<uuid>` + at most one simple extension), so the
// extension taken from a client-supplied filename has to be reduced to plain
// alphanumerics before it becomes part of a blob path.
describe("sanitizeBlobExtension", () => {
  it("keeps a simple extension", () => {
    expect(sanitizeBlobExtension("photo.jpg")).toBe("jpg");
  });

  it("takes only the last extension of a multi-dot name", () => {
    expect(sanitizeBlobExtension("archive.tar.gz")).toBe("gz");
  });

  it("strips path separators and dot-segments smuggled after the last dot", () => {
    expect(sanitizeBlobExtension("photo.jpg/../../evil")).toBe("evil");
  });

  it("strips non-alphanumeric characters", () => {
    expect(sanitizeBlobExtension("photo.j p-g%")).toBe("jpg");
  });

  it("returns empty string when there is no extension", () => {
    expect(sanitizeBlobExtension("noext")).toBe("");
  });

  it("returns empty string for a trailing dot", () => {
    expect(sanitizeBlobExtension("trailing.")).toBe("");
  });

  it("caps runaway extensions at 10 characters", () => {
    expect(sanitizeBlobExtension(`file.${"a".repeat(40)}`)).toBe("a".repeat(10));
  });
});
