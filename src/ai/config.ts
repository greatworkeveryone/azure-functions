// The AI gateway's settings (docs/runbooks/switches.md). Read on every call, never
// cached, so a switch changed in Azure takes effect without a restart. Nothing here
// ever reaches a client: getAiStatus sends only the fields it names.

import { checkBaseUrl } from "./baseUrl";
import type { AiProviderName } from "./types";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_RATE_PER_MINUTE = 20;
export const MAX_RATE_PER_MINUTE = 1_000;
const MAX_ENABLED_PURPOSES = 50;
const PURPOSE_ID = /^[a-z][a-z0-9_]{0,63}$/;

export interface AiConfig {
  /** Bearer token for the endpoint; optional for a self-hosted one. */
  apiKey: string | null;
  baseUrl: string | null;
  /** Only the exact string "true" turns AI on. */
  enabled: boolean;
  /** AI_PURPOSES_ENABLED: the purposes switched on, one by one. None by default; there is no "all". */
  enabledPurposes: string[];
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

/**
 * A comma list of purpose ids. Anything that is not a purpose id is dropped, so a typo or a wildcard
 * switches nothing on; repeats collapse; the list stops at 50 so a stray value cannot grow without limit.
 */
function purposeList(value: string | undefined): string[] {
  const ids: string[] = [];
  for (const part of (value ?? "").split(",")) {
    const id = part.trim();
    if (PURPOSE_ID.test(id) && !ids.includes(id)) ids.push(id);
    if (ids.length === MAX_ENABLED_PURPOSES) break;
  }
  return ids;
}

export function readAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  return {
    apiKey: text(env.AI_API_KEY),
    baseUrl: text(env.AI_BASE_URL),
    enabled: env.AI_ENABLED === "true",
    enabledPurposes: purposeList(env.AI_PURPOSES_ENABLED),
    model: text(env.AI_MODEL),
    provider: text(env.AI_PROVIDER)?.toLowerCase() ?? "mock",
    ratePerMinute: wholeNumber(env.AI_RATE_PER_MINUTE, DEFAULT_RATE_PER_MINUTE, MAX_RATE_PER_MINUTE),
    timeoutMs: wholeNumber(env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
  };
}

/** Whether the chosen provider has what it needs to be called: an endpoint needs a model and an address that may be called (https, or http to a private one). The mock needs nothing. */
export function isConfigured(config: AiConfig): boolean {
  if (config.provider === "mock") return true;
  return config.provider === "openai_compatible" && config.model !== null && checkBaseUrl(config.baseUrl).ok;
}
