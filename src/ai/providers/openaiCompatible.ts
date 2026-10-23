// The provider for a self-hosted, OpenAI-compatible endpoint (vLLM or Ollama on
// Randazzo Properties' own Azure tenant): POST ${AI_BASE_URL}/v1/chat/completions.
//
// Temperature is 0 and JSON mode is asked for when the purpose expects JSON. The
// call is cut off after AI_TIMEOUT_MS. The bearer key is sent only when AI_API_KEY
// is set, and redirects are refused so it can never be handed to another host.
// Whatever the endpoint says on a failure is thrown away: AiProviderFailure holds a
// status code or a short phrase, never the response body, because an error body can
// echo the prompt. The answer is read as it arrives and abandoned past 1 MB.
//
// Nothing is sent unless AI_BASE_URL passes checkBaseUrl (../baseUrl): https, or http to
// localhost or a private address only. A refusal is logged with the reason (runAi) and the
// call fails as provider_error before any network use.

import { checkBaseUrl } from "../baseUrl";
import { isRecord } from "../validate";
import { AiProviderFailure } from "../refusals";
import type { AiConfig } from "../config";
import type { AiPurpose } from "../types";
import type { ProviderAnswer } from "./types";

const MAX_RESPONSE_BYTES = 1_000_000;

/** `${AI_BASE_URL}/v1/chat/completions`, with any trailing slash on the base removed. Throws unless the address may be called. */
export function chatCompletionsUrl(baseUrl: string | null): string {
  const checked = checkBaseUrl(baseUrl);
  if (!checked.ok) throw new AiProviderFailure("provider_error", checked.problem);
  return `${(baseUrl ?? "").replace(/\/+$/, "")}/v1/chat/completions`;
}

const tooLong = () => new AiProviderFailure("provider_error", "The AI endpoint's answer was far too long");

/** The body as text, read chunk by chunk: a declared length over the limit is refused unread, and an endless body is cancelled at the limit. */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLong();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLong();
    }
    text += decoder.decode(value, { stream: true });
  }
}

function requestBody(config: AiConfig, purpose: AiPurpose, input: string): string {
  return JSON.stringify({
    max_tokens: purpose.maxOutputTokens,
    messages: [
      { content: purpose.systemPrompt, role: "system" },
      { content: input, role: "user" },
    ],
    model: config.model,
    temperature: 0,
    ...(purpose.expectsJson ? { response_format: { type: "json_object" } } : {}),
  });
}

function answerText(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiProviderFailure("provider_error", "The AI endpoint did not answer in JSON");
  }
  const choices = isRecord(parsed) ? parsed.choices : undefined;
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(first) ? first.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content !== "string") throw new AiProviderFailure("provider_error", "The AI endpoint's answer had no message text");
  return content;
}

export async function callOpenAiCompatible(config: AiConfig, purpose: AiPurpose, input: string): Promise<ProviderAnswer> {
  const url = chatCompletionsUrl(config.baseUrl);
  if (!config.model) throw new AiProviderFailure("provider_error", "AI_MODEL is not set");

  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(url, {
      body: requestBody(config, purpose, input),
      headers,
      method: "POST",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new AiProviderFailure("provider_error", `The AI endpoint answered ${response.status}`);
    return { model: config.model, text: answerText(await readBounded(response)) };
  } catch (error) {
    if (error instanceof AiProviderFailure) throw error;
    if (controller.signal.aborted) throw new AiProviderFailure("timeout", `The AI endpoint did not answer within ${config.timeoutMs} ms`);
    throw new AiProviderFailure("provider_error", "The AI endpoint could not be reached");
  } finally {
    clearTimeout(timer);
  }
}
