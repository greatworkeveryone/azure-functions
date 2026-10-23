// runAi: the only way any code in this app reaches a model (SC-AI1).
//
// In order, and stopping at the first refusal:
//   0. in flight: a person may have two calls running on this instance; a third is turned away
//   1. this person's rows in AiCallLog for the last minute are counted, every outcome included;
//      above twice AI_RATE_PER_MINUTE the call is turned away before any row is written (429)
//   2. the switch (AI_ENABLED must equal "true"): off means nothing is sent anywhere
//   3. the purpose allowlist: the purpose must exist (./registry) AND be listed in
//      AI_PURPOSES_ENABLED, so each purpose is switched on on its own (default: none)
//   4. the size cap (the purpose's maxInputChars)
//   5. the per-minute limit itself (AI_RATE_PER_MINUTE): at it, a refusal that is logged
//   6. redaction: personal details are replaced; a provider only ever sees the result
//   7. the provider call, cut off after AI_TIMEOUT_MS
//   8. parse and check the answer against the purpose's validator
//   9. one AiCallLog row (refusals included), then the typed result
//
// The model's text is untrusted data throughout: it is parsed, never executed, and
// callers get only what the purpose's validator let through. Never render it as HTML.
// A result with meta.throttled is one a route answers with HTTP 429 (see ./http.ts).

import { refused, settle, startCall, throttled } from "./call";
import { countRecentAiCalls } from "./callLog";
import { readAiConfig, type AiConfig } from "./config";
import { withServiceConnection } from "./connection";
import { takeSlot } from "./inFlight";
import { interpretOutput } from "./output";
import { callProvider, type ProviderAnswer } from "./providers";
import { AiProviderFailure } from "./refusals";
import { getPurpose } from "./registry";
import type { AiRefusalCode, AiRequest, AiResult } from "./types";

/** The model a call was meant for, so a timeout or a provider error still says which one. */
function intendedModel(config: AiConfig): string | null {
  return config.provider === "mock" ? "mock" : config.model;
}

function failureCode(error: unknown): Extract<AiRefusalCode, "provider_error" | "timeout"> {
  // The message of an AiProviderFailure is a status code or a short phrase, never provider text, so it may be logged.
  console.error(`[ai] provider call failed: ${error instanceof AiProviderFailure ? error.message : "unexpected error"}`);
  return error instanceof AiProviderFailure ? error.code : "provider_error";
}

export async function runAi<Output = unknown>(request: AiRequest): Promise<AiResult<Output>> {
  const config = readAiConfig();
  const purpose = getPurpose(request.purpose);
  const call = startCall(request, config, purpose);

  const release = takeSlot(call.actor);
  if (!release) return throttled(call);
  try {
    // A failure to count is not read as zero: the call is not made.
    const recent = await withServiceConnection((connection) => countRecentAiCalls(connection, call.actor));
    if (recent > 2 * config.ratePerMinute) return throttled(call);

    if (!config.enabled) return await settle(call, refused("disabled"));
    if (!purpose || !config.enabledPurposes.includes(purpose.id)) return await settle(call, refused("purpose_not_allowed"));
    if (call.input.length > purpose.maxInputChars) return await settle(call, refused("input_too_large"));
    if (recent >= config.ratePerMinute) return await settle(call, refused("rate_limited"));

    const sent = call.prepared().redaction.text;
    const startedAt = Date.now();
    let answer: ProviderAnswer;
    try {
      answer = await callProvider(config, purpose, sent);
    } catch (error) {
      return await settle(call, { code: failureCode(error), latencyMs: Date.now() - startedAt, model: intendedModel(config), outputChars: null });
    }
    const latencyMs = Date.now() - startedAt;

    // The purpose's validator sees the redacted input too, so a citation can be checked against what was sent (SC-AI4).
    const checked = interpretOutput(purpose, answer.text, sent);
    if (!checked.ok) return await settle(call, { code: "invalid_output", latencyMs, model: answer.model, outputChars: answer.text.length });
    return await settle(call, { code: null, latencyMs, model: answer.model, output: checked.value, outputChars: answer.text.length });
  } finally {
    release();
  }
}
