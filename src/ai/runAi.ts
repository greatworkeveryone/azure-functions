// runAi: the only way any code in this app reaches a model (SC-AI1).
//
// In order, and stopping at the first refusal:
//   1. the switch (AI_ENABLED must equal "true"): off means nothing is sent anywhere
//   2. the purpose allowlist (./registry)
//   3. the size cap (the purpose's maxInputChars)
//   4. this person's rate limit (AI_RATE_PER_MINUTE, counted from AiCallLog)
//   5. redaction: personal details are replaced; a provider only ever sees the result
//   6. the provider call, cut off after AI_TIMEOUT_MS
//   7. parse and check the answer against the purpose's validator
//   8. one AiCallLog row (refusals included), then the typed result
//
// The model's text is untrusted data throughout: it is parsed, never executed, and
// callers get only what the purpose's validator let through. Never render it as HTML.

import { refused, settle, startCall } from "./call";
import { countRecentAiCalls } from "./callLog";
import { readAiConfig, type AiConfig } from "./config";
import { withServiceConnection } from "./connection";
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

  if (!config.enabled) return settle(call, refused("disabled"));
  if (!purpose) return settle(call, refused("purpose_not_allowed"));
  if (call.input.length > purpose.maxInputChars) return settle(call, refused("input_too_large"));
  // A failure to count is not read as zero: the call is not made.
  const recent = await withServiceConnection((connection) => countRecentAiCalls(connection, call.actor));
  if (recent >= config.ratePerMinute) return settle(call, refused("rate_limited"));

  const startedAt = Date.now();
  let answer: ProviderAnswer;
  try {
    answer = await callProvider(config, purpose, call.prepared().redaction.text);
  } catch (error) {
    return settle(call, { code: failureCode(error), latencyMs: Date.now() - startedAt, model: intendedModel(config), outputText: null });
  }
  const latencyMs = Date.now() - startedAt;

  const checked = interpretOutput(purpose, answer.text);
  if (!checked.ok) return settle(call, { code: "invalid_output", latencyMs, model: answer.model, outputText: answer.text });
  return settle(call, { code: null, latencyMs, model: answer.model, output: checked.value, outputText: answer.text });
}
