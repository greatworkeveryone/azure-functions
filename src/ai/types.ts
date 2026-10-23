// The AI gateway's contract (SC-AI1). runAi (./runAi.ts) is the only way any
// code in this app reaches a model; everything it accepts and returns is here.

/** Why a call produced no answer. Every code is logged on the call's AiCallLog row. */
export const AI_REFUSAL_CODES = [
  "disabled",
  "purpose_not_allowed",
  "input_too_large",
  "rate_limited",
  "timeout",
  "provider_error",
  "invalid_output",
] as const;

export type AiRefusalCode = (typeof AI_REFUSAL_CODES)[number];

/**
 * ok: an answer that passed its purpose's checks.
 * refused: declined before anything was sent (switch off, purpose not allowed, too long, too many calls).
 * failed: the provider was called, or should have been, and gave no usable answer.
 */
export type AiOutcome = "ok" | "refused" | "failed";

export const AI_OUTCOMES: readonly AiOutcome[] = ["ok", "refused", "failed"];

export type AiProviderName = "mock" | "openai_compatible";

/** The person (or process) a call is made for, as the decision ledger names an actor, plus their email. */
export interface AiActor {
  email: string | null;
  kind: "system" | "user";
  name: string;
  role: string | null;
  /** AppUsers.UserID; null for a system actor or someone not in AppUsers. */
  userId: number | null;
}

export interface AiRequest {
  actor: AiActor;
  /** Ties the call to other log rows (an upload, a request); a fresh one is made when absent or not a UUID. */
  correlationId?: string;
  /** The text the purpose works on. Personal details are replaced before it goes to a provider. */
  input: string;
  /** An id from the purpose registry. Anything else is refused as purpose_not_allowed. */
  purpose: string;
  /** What the call was about, for the log: "quote", "invoice", "procedure"... */
  recordId?: string;
  recordType?: string;
}

export interface AiRefusal {
  code: AiRefusalCode;
  /** A plain sentence for the person using the screen. Never provider text. */
  message: string;
}

/** What every result says about the call, answered or not. */
export interface AiCallMeta {
  /** The AiCallLog row id; null when the row could not be written (only ever on a refusal). */
  callId: number | null;
  correlationId: string;
  latencyMs: number | null;
  model: string | null;
  promptVersion: string | null;
  provider: string;
  purpose: string;
  redactionCount: number;
}

export type AiResult<Output = unknown> =
  | { meta: AiCallMeta; ok: true; output: Output }
  | { meta: AiCallMeta; ok: false; refusal: AiRefusal };

export type AiValidation<Output> = { ok: true; value: Output } | { ok: false; reason: string };

/**
 * One thing the app may ask a model to do. A purpose is a file in ./purposes: the
 * registry picks it up by itself, so adding one touches no other file. Model output
 * is untrusted data: `validate` is the only door it comes through.
 */
export interface AiPurpose<Output = unknown> {
  /** True when the model must answer in JSON: the provider asks for it and the text is parsed before `validate`. */
  expectsJson: boolean;
  /** snake_case. What callers pass as `purpose` and what the log records. */
  id: string;
  /** Longest input, in characters, the purpose accepts. A longer one is refused, not cut. */
  maxInputChars: number;
  maxOutputTokens: number;
  /** A deterministic stand-in for the model, used by the mock provider: the text a model would send back. */
  mock: (input: string) => string;
  /** `<id>@<whole number>`. Change it whenever the prompt or the validator changes. */
  promptVersion: string;
  systemPrompt: string;
  /** Gets the parsed JSON (expectsJson) or the trimmed text. Returns only what the purpose trusts. */
  validate: (value: unknown) => AiValidation<Output>;
}

/** Identity helper: lets a purpose file infer its output type from `validate`. */
export function definePurpose<Output>(purpose: AiPurpose<Output>): AiPurpose<Output> {
  return purpose;
}
