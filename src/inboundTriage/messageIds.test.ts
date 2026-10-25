import { ancestorIds, headerValue, normaliseMessageId, parseMessageIds, replyHeaders, REFERENCES_MAX } from "./messageIds";

describe("parseMessageIds", () => {
  it("reads bracketed ids in order, without brackets and in lower case", () => {
    expect(parseMessageIds("<A1@Mail.example> <b2@mail.example>\n <c3@x>")).toEqual(["a1@mail.example", "b2@mail.example", "c3@x"]);
  });

  it("reads a bare id when there are no brackets, and ignores words that are not ids", () => {
    expect(parseMessageIds("abc@x.example")).toEqual(["abc@x.example"]);
    expect(parseMessageIds("hello there")).toEqual([]);
  });

  it("drops duplicates and answers an empty list for nothing", () => {
    expect(parseMessageIds("<a@x> <a@x>")).toEqual(["a@x"]);
    expect(parseMessageIds(null)).toEqual([]);
    expect(parseMessageIds("")).toEqual([]);
  });

  it("normalises one id the same way", () => {
    expect(normaliseMessageId(" <ID@X> ")).toBe("id@x");
  });
});

describe("replyHeaders", () => {
  const headers = [
    { name: "Received", value: "from somewhere" },
    { name: "In-Reply-To", value: "<Parent@x>" },
    { name: "references", value: "<root@x> <mid@x> <parent@x>" },
  ];

  it("takes In-Reply-To and References from the headers, names matched without regard to case", () => {
    expect(replyHeaders(headers)).toEqual({ inReplyTo: "parent@x", referenceIds: "root@x mid@x parent@x" });
    expect(headerValue(headers, "RECEIVED")).toBe("from somewhere");
  });

  it("is null for both when the email is not a reply", () => {
    expect(replyHeaders([{ name: "Subject", value: "x" }])).toEqual({ inReplyTo: null, referenceIds: null });
  });

  it("keeps the newest References ids when they do not all fit", () => {
    const ids = Array.from({ length: 400 }, (_, i) => `<id${String(i).padStart(4, "0")}@example.test>`);
    const { referenceIds } = replyHeaders([{ name: "References", value: ids.join(" ") }]);
    expect((referenceIds ?? "").length).toBeLessThanOrEqual(REFERENCES_MAX);
    expect(referenceIds?.endsWith("id0399@example.test")).toBe(true);
    expect(referenceIds?.startsWith("id0000")).toBe(false);
  });
});

describe("ancestorIds", () => {
  it("lists References oldest first and In-Reply-To last, each once, nearest last", () => {
    expect(ancestorIds("parent@x", "root@x parent@x mid@x")).toEqual(["root@x", "mid@x", "parent@x"]);
    expect(ancestorIds(null, null)).toEqual([]);
  });
});
