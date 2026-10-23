// The AI gateway's settings (docs/runbooks/switches.md). Read on every call, never
// cached, so a switch changed in Azure takes effect without a restart. Nothing here
// ever reaches a client: getAiStatus sends only the fields it names.

import type { AiProviderName } from "./types";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_RATE_PER_MINUTE = 20;
export const MAX_RATE_PER_MINUTE = 1_000;

export interface AiConfig {
  /** Bearer token for the endpoint; optional for a self-hosted one. */
  apiKey: string | null;
  baseUrl: string | null;
  /** Only the exact string "true" turns AI on. */
  enabled: boolean;
  /** Store the (redacted) input and the output with each call. The log is append-only: stored text can never be removed. */
  logContent: boolean;
  model: string | null;
  /** The raw AI_PROVIDER value, trimmed and lower-cased; anything but a known name is refused as provider_error. */
  provider: string;
  ratePerMinute: number;
  timeoutMs: number;
}

const PROVIDERS: readonly AiProviderName[] = ["mock", "openai_compatible"];

export const isKnownProvider = (name: string): name is AiProviderName => (PROVIDERS as readonly string[]).includes(name);

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** A whole number from 1 to `max`, else the default: a typo never switches a limit off. */
function wholeNumber(value: string | undefined, fallback: number, max: number): number {
  const raw = value?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return parsed >= 1 && parsed <= max ? parsed : fallback;
}

export function readAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  return {
    apiKey: text(env.AI_API_KEY),
    baseUrl: text(env.AI_BASE_URL),
    enabled: env.AI_ENABLED === "true",
    logContent: env.AI_LOG_CONTENT === "true",
    model: text(env.AI_MODEL),
    provider: text(env.AI_PROVIDER)?.toLowerCase() ?? "mock",
    ratePerMinute: wholeNumber(env.AI_RATE_PER_MINUTE, DEFAULT_RATE_PER_MINUTE, MAX_RATE_PER_MINUTE),
    timeoutMs: wholeNumber(env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
  };
}

/** Whether the chosen provider has what it needs to be called. The mock needs nothing. */
export function isConfigured(config: AiConfig): boolean {
  if (config.provider === "mock") return true;
  return config.provider === "openai_compatible" && config.baseUrl !== null && config.model !== null;
}
