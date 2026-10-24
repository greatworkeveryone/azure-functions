// What a person is told when a call gives no answer (SC-AI1), and the one error a
// provider throws. The sentences are fixed here: nothing a provider says ever
// reaches a screen, because its error text can echo what was sent to it.

import type { AiOutcome, AiRefusal, AiRefusalCode } from "./types";

export const REFUSAL_MESSAGES: Record<AiRefusalCode, string> = {
  disabled: "AI is switched off, so nothing was sent to a model.",
  input_too_large: "That is too long for the AI to read. Shorten it and try again.",
  invalid_output: "The AI's answer didn't pass Floorplan's checks, so it was not used.",
  provider_error: "The AI couldn't be reached. Try again, and tell an admin if it keeps happening.",
  purpose_not_allowed: "Floorplan isn't set up to use AI for that.",
  rate_limited: "That is too many AI requests in a minute. Wait a moment and try again.",
  timeout: "The AI took too long to answer. Try again.",
};

export const refusal = (code: AiRefusalCode): AiRefusal => ({ code, message: REFUSAL_MESSAGES[code] });

/** refused: nothing was sent. failed: the provider was called, or should have been, and gave no usable answer. */
export function outcomeFor(code: AiRefusalCode): AiOutcome {
  return code === "timeout" || code === "provider_error" || code === "invalid_output" ? "failed" : "refused";
}

/** The log row for an answered call could not be written, so the answer was withheld: no AI output leaves the gateway unrecorded. */
export class AiAuditError extends Error {
  constructor() {
    super("The AI call could not be recorded, so its answer was not used.");
    this.name = "AiAuditError";
  }
}

/** Thrown by a provider; only the code survives. The message is for the server log and never holds provider text. */
export class AiProviderFailure extends Error {
  readonly code: "provider_error" | "timeout";

  constructor(code: "provider_error" | "timeout", message: string) {
    super(message);
    this.name = "AiProviderFailure";
    this.code = code;
  }
}
