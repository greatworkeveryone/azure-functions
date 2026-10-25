// The mock provider (AI_PROVIDER=mock, the default): the purpose's own
// deterministic stand-in for a model. No network, no key, same answer every time,
// and its text goes through the same parsing and checks as a real model's.

import { AiProviderFailure } from "../refusals";
import type { AiPurpose } from "../types";
import type { ProviderAnswer } from "./types";

export const MOCK_MODEL = "mock";

export function callMock(purpose: AiPurpose, input: string): ProviderAnswer {
  let text: unknown;
  try {
    text = purpose.mock(input);
  } catch {
    throw new AiProviderFailure("provider_error", `The mock responder for ${purpose.id} threw`);
  }
  if (typeof text !== "string") throw new AiProviderFailure("provider_error", `The mock responder for ${purpose.id} returned no text`);
  return { model: MOCK_MODEL, text };
}
