/// <reference types="jest" />
import { createHash } from "node:crypto";
import { recordExternalAiCall, type ExternalAiCall } from "./externalCall";

jest.mock("./connection", () => ({ withServiceConnection: jest.fn(async (work: (c: object) => Promise<unknown>) => work({})) }));
jest.mock("./callLog", () => ({ insertAiCall: jest.fn(async () => 1) }));

import { insertAiCall } from "./callLog";
import { withServiceConnection } from "./connection";

const CALL: ExternalAiCall = {
  actorName: "Email parsing",
  errorCode: null,
  input: "Quote attached. Call me on 0412 345 678 or jo@example.com",
  latencyMs: 1800,
  model: "llama3.1:8b",
  outputChars: 420,
  promptVersion: "parse-incoming@toddler",
  provider: "toddler",
  purpose: "email_reading",
  recordId: "42",
  recordType: "email",
};

const entry = () => jest.mocked(insertAiCall).mock.calls[0][1];

beforeEach(() => jest.clearAllMocks());

describe("recordExternalAiCall", () => {
  it("writes an answered call as a system actor, with the record it was about", async () => {
    await recordExternalAiCall(CALL, jest.fn());
    expect(entry()).toMatchObject({
      actor: { kind: "system", name: "Email parsing", userId: null },
      errorCode: null,
      inputChars: CALL.input.length,
      latencyMs: 1800,
      outcome: "ok",
      purpose: "email_reading",
      recordId: "42",
      recordType: "email",
    });
  });

  it("hashes the redacted input, never the raw text, and counts what it redacted", async () => {
    await recordExternalAiCall(CALL, jest.fn());
    const raw = createHash("sha256").update(CALL.input, "utf8").digest("hex");
    expect(entry().inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry().inputSha256).not.toBe(raw);
    expect(entry().redactionCount).toBe(2);
  });

  it("writes a failed call with its code", async () => {
    await recordExternalAiCall({ ...CALL, errorCode: "timeout", outputChars: null }, jest.fn());
    expect(entry()).toMatchObject({ errorCode: "timeout", outcome: "failed", outputChars: null });
  });

  it("never throws when the row can't be written, and says so", async () => {
    jest.mocked(withServiceConnection).mockRejectedValueOnce(new Error("db down"));
    const onError = jest.fn();
    await expect(recordExternalAiCall(CALL, onError)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "db down" }));
  });
});
