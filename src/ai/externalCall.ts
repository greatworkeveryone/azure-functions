// Records an AI call made outside the gateway (the email parser calls toddler's /parse-incoming itself) in
// AiCallLog, so usage and cost-per-call count it. Same row rules as the gateway: a hash of the REDACTED input,
// never the prompt or the answer. Best effort: it never throws, since a missing row must not cost an email its parse.

import { createHash, randomUUID } from "node:crypto";
import { insertAiCall } from "./callLog";
import { withServiceConnection } from "./connection";
import { redactText } from "./redaction";
import type { AiRefusalCode } from "./types";

export interface ExternalAiCall {
  /** Who the log names, e.g. "Email parsing". Always a system actor: no person asked for the call. */
  actorName: string;
  /** null when the call answered. */
  errorCode: AiRefusalCode | null;
  input: string;
  latencyMs: number;
  model: string | null;
  outputChars: number | null;
  promptVersion: string;
  provider: string;
  purpose: string;
  recordId: string | null;
  recordType: string | null;
}

// As the gateway's unknown-purpose cap: hashing a 2 MB email body buys nothing.
const HASH_CHARS = 100_000;

export async function recordExternalAiCall(call: ExternalAiCall, onError: (error: unknown) => void): Promise<void> {
  try {
    const redaction = redactText(call.input.slice(0, HASH_CHARS));
    await withServiceConnection((connection) =>
      insertAiCall(connection, {
        actor: { email: null, kind: "system", name: call.actorName, role: null, userId: null },
        correlationId: randomUUID(),
        errorCode: call.errorCode,
        inputChars: call.input.length,
        inputSha256: createHash("sha256").update(redaction.text, "utf8").digest("hex"),
        latencyMs: call.latencyMs,
        model: call.model,
        outcome: call.errorCode === null ? "ok" : "failed",
        outputChars: call.outputChars,
        promptVersion: call.promptVersion,
        provider: call.provider,
        purpose: call.purpose,
        recordId: call.recordId,
        recordType: call.recordType,
        redactionCount: redaction.count,
      }),
    );
  } catch (error: unknown) {
    onError(error);
  }
}
