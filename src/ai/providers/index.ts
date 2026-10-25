// Chooses the provider for a call by AI_PROVIDER (default mock). Anything else, or
// an openai_compatible endpoint that is missing its URL or model (or whose URL may
// not be called, see ../baseUrl), fails as provider_error before anything is sent.

import { AiProviderFailure } from "../refusals";
import type { AiConfig } from "../config";
import type { AiPurpose } from "../types";
import { callMock } from "./mock";
import { callOpenAiCompatible } from "./openaiCompatible";
import type { ProviderAnswer } from "./types";

export type { ProviderAnswer } from "./types";

/** `input` is already redacted: a provider never sees the original text. */
export async function callProvider(config: AiConfig, purpose: AiPurpose, input: string): Promise<ProviderAnswer> {
  if (config.provider === "mock") return callMock(purpose, input);
  if (config.provider !== "openai_compatible") throw new AiProviderFailure("provider_error", "AI_PROVIDER is not a known provider");
  // The address itself is checked, with its own reason, where the URL is built.
  if (!config.baseUrl || !config.model) throw new AiProviderFailure("provider_error", "AI_BASE_URL and AI_MODEL must both be set");
  return callOpenAiCompatible(config, purpose, input);
}
