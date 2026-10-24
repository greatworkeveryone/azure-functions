import { buildTriageInput, readTriageInput, TRIAGE_LIMITS } from "./input";

describe("buildTriageInput", () => {
  it("lays out the subject and body, and reads them back", () => {
    const input = buildTriageInput("Lift  is\nout", "Hello\r\n\r\n\r\n\r\nthere   you");
    expect(input).toBe("Subject: Lift is out\nBody:\nHello\n\nthere you");
    expect(readTriageInput(input)).toEqual({ body: "Hello\n\nthere you", subject: "Lift is out" });
  });

  it("never exceeds what the purpose accepts, however long the email", () => {
    const input = buildTriageInput("s".repeat(5000), "b".repeat(50_000));
    expect(input.length).toBeLessThanOrEqual(TRIAGE_LIMITS.maxInputChars);
    expect(readTriageInput(input).subject).toHaveLength(TRIAGE_LIMITS.subjectChars);
  });

  it("is built from the subject and body alone, so the sender's name and address never reach a model", () => {
    expect(buildTriageInput(null, null)).toBe("Subject: \nBody:\n");
  });

  it("reads nothing back from text that is not in this layout", () => {
    expect(readTriageInput("hello")).toEqual({ body: "", subject: "" });
  });
});
