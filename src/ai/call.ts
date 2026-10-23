// One AI call's bookkeeping (SC-AI1): what is known about it up front, and how it
// is settled: the AiCallLog row written, and the typed result handed back.

import { createHash, randomUUID } from "node:crypto";
import { Sentry } from "../sentry";
import { insertAiCall, type AiLogEntry } from "./callLog";
import { withServiceConnection } from "./connection";
import { redactText, type Redaction } from "./redaction";
import { AiAuditError, outcomeFor, refusal } from "./refusals";
import type { AiConfig } from "./config";
import type { AiActor, AiPurpose, AiRefusalCode, AiRequest, AiResult } from "./types";

// Redaction and the input fingerprint look at no more than this many characters
// of a refused call's input, so an enormous input cannot make a refusal expensive.
const UNKNOWN_PURPOSE_HASH_CHARS = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An answer longer than this many characters per token of the purpose's budget is refused, and
// only this much of it is ever stored (when content logging is on): a runaway answer cannot fill
// an append-only table. OutputChars still records its full length.
const LOGGED_CHARS_PER_TOKEN = 8;

export interface AiCall {
  readonly actor: AiActor;
  readonly config: AiConfig;
  readonly correlationId: string;
  readonly input: string;
  /** The input with personal details replaced, worked out once and only when something needs it. */
  prepared: () => { redaction: Redaction; sha256: string };
  readonly purpose: AiPurpose | undefined;
  readonly purposeId: string;
  readonly recordId: string | null;
  readonly recordType: string | null;
}

export interface Settled {
  /** null: an answer that passed its checks. */
  code: AiRefusalCode | null;
  latencyMs: number | null;
  model: string | null;
  output?: unknown;
  /** The model's raw text, when it sent any. */
  outputText: string | null;
}

export const refused = (code: AiRefusalCode): Settled => ({ code, latencyMs: null, model: null, outputText: null });

/**
 * The result for a call turned away because the person is sending too many: no row is written
 * (a flood must not be able to fill a log that can never be purged), nothing is redacted or
 * sent, and `meta.throttled` tells the route to answer 429.
 */
export function throttled<Output>(call: AiCall): AiResult<Output> {
  return {
    meta: {
      callId: null,
      correlationId: call.correlationId,
      latencyMs: null,
      model: null,
      promptVersion: call.purpose?.promptVersion ?? null,
      provider: call.config.provider,
      purpose: call.purposeId,
      redactionCount: 0,
      throttled: true,
    },
    ok: false,
    refusal: refusal("rate_limited"),
  };
}

export function startCall(request: AiRequest, config: AiConfig, purpose: AiPurpose | undefined): AiCall {
  const input = typeof request.input === "string" ? request.input : "";
  const cap = purpose?.maxInputChars ?? UNKNOWN_PURPOSE_HASH_CHARS;
  let prepared: ReturnType<AiCall["prepared"]> | null = null;
  return {
    actor: request.actor,
    config,
    correlationId: typeof request.correlationId === "string" && UUID.test(request.correlationId) ? request.correlationId.toLowerCase() : randomUUID(),
    input,
    prepared: () => {
      if (!prepared) {
        const redaction = redactText(input.length > cap ? input.slice(0, cap) : input);
        prepared = { redaction, sha256: createHash("sha256").update(redaction.text, "utf8").digest("hex") };
      }
      return prepared;
    },
    purpose,
    purposeId: String(request.purpose ?? "").slice(0, 64) || "(none)",
    recordId: request.recordId === undefined ? null : String(request.recordId),
    recordType: request.recordType === undefined ? null : String(request.recordType),
  };
}

/**
 * Writes the call's row and returns its result. A refusal is returned even when
 * its row cannot be written (nothing was done, so nothing is lost; Sentry hears of
 * it). An answer is not: if its row cannot be written the answer is withheld, so
 * no AI output ever leaves the gateway unrecorded.
 */
export async function settle<Output>(call: AiCall, settled: Settled): Promise<AiResult<Output>> {
  const { redaction, sha256 } = call.prepared();
  const outcome = settled.code === null ? "ok" : outcomeFor(settled.code);
  // Content goes in only for a call that reached the model, only when asked for, and only redacted.
  const keepText = call.config.logContent && outcome !== "refused";
  const entry: AiLogEntry = {
    actor: call.actor,
    correlationId: call.correlationId,
    errorCode: settled.code,
    inputChars: call.input.length,
    inputSha256: sha256,
    inputText: keepText ? redaction.text : null,
    latencyMs: settled.latencyMs,
    model: settled.model,
    outcome,
    outputChars: settled.outputText === null ? null : settled.outputText.length,
    outputText:
      keepText && settled.outputText !== null
        ? redactText(settled.outputText.slice(0, (call.purpose?.maxOutputTokens ?? 0) * LOGGED_CHARS_PER_TOKEN)).text
        : null,
    promptVersion: call.purpose?.promptVersion ?? "unknown",
    provider: call.config.provider,
    purpose: call.purposeId,
    recordId: call.recordId,
    recordType: call.recordType,
    redactionCount: redaction.count,
  };

  let callId: number | null = null;
  try {
    callId = await withServiceConnection((connection) => insertAiCall(connection, entry));
  } catch (error) {
    Sentry.captureException(error, { extra: { context: "AI call log insert failed", outcome, purpose: call.purposeId } });
    if (outcome === "ok") throw new AiAuditError();
  }

  const meta = {
    callId,
    correlationId: call.correlationId,
    latencyMs: settled.latencyMs,
    model: settled.model,
    promptVersion: call.purpose?.promptVersion ?? null,
    provider: call.config.provider,
    purpose: call.purposeId,
    redactionCount: redaction.count,
    throttled: false,
  };
  return settled.code === null
    ? { meta, ok: true, output: settled.output as Output }
    : { meta, ok: false, refusal: refusal(settled.code) };
}
