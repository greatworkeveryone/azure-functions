import { findPoNumber, findReferencePoNumbers } from "./po-ref";

describe("findReferencePoNumbers", () => {
  it("returns only real current-format numbers, in order, without repeats", () => {
    const text = "PO 66Sm261013 and PO 9Ce261013b; again PO 66Sm261013. PO ABC-123. PO 260419-PO-42-ACM-7";
    expect(findReferencePoNumbers(text)).toEqual(["66Sm261013", "9Ce261013b"]);
  });

  it("is case-sensitive about the codes", () => {
    expect(findReferencePoNumbers("PO 66SM261013")).toEqual([]);
    expect(findReferencePoNumbers("PO mcmgm261013")).toEqual([]);
    expect(findReferencePoNumbers("po McMgm261013")).toEqual(["McMgm261013"]);
  });

  it("rejects impossible dates", () => {
    expect(findReferencePoNumbers("PO 66Sm261332")).toEqual([]);
    expect(findReferencePoNumbers("PO 66Sm250229")).toEqual([]);
  });

  it("handles quarter, half and annual references", () => {
    expect(findReferencePoNumbers("PO McMgm26q3 / Order No. ALLins26a")).toEqual(["McMgm26q3", "ALLins26a"]);
  });

  it("returns [] for empty input", () => {
    expect(findReferencePoNumbers(null)).toEqual([]);
    expect(findReferencePoNumbers(undefined)).toEqual([]);
    expect(findReferencePoNumbers("")).toEqual([]);
  });

  it("requires a label: a bare number is not found", () => {
    expect(findReferencePoNumbers("Reference 66Sm261013")).toEqual([]);
  });
});

describe("findPoNumber", () => {
  it("prefers real numbers over loose ones regardless of position", () => {
    expect(findPoNumber("PO ABC-123 then PO 66Sm261013")).toBe("66Sm261013");
  });

  it("falls back to the first loose token with a digit or hyphen", () => {
    expect(findPoNumber("PO: SUBJECT-REF\nPO: BODY-REF")).toBe("SUBJECT-REF");
    expect(findPoNumber("PO #1234")).toBe("1234");
  });

  it("ignores plain words and trailing hyphens", () => {
    expect(findPoNumber("PO number")).toBeNull();
    expect(findPoNumber("PO ABC-123-")).toBe("ABC-123");
  });

  it("returns null for empty input", () => {
    expect(findPoNumber(null)).toBeNull();
    expect(findPoNumber("")).toBeNull();
  });

  it("drops tokens longer than the 21 characters the legacy pattern allowed", () => {
    expect(findPoNumber("PO 1234567890123456789012345")).toBeNull();
  });
});
