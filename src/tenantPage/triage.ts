// Staff-side triage hint for a tenant request (TR3). Floorplan's rules always produce a suggestion; the
// AI gateway (purpose tenant_request_triage) may replace it when AI is switched on and answers. The
// suggestion is stored in separate Triage* columns for staff only. It never changes what the tenant
// submitted (their category, urgency and words are stored as sent), is never returned to the tenant,
// and a refusal, timeout or bad answer simply leaves the rules' suggestion in place.

import { readAiConfig, isConfigured } from "../ai/config";
import { runAi } from "../ai/runAi";
import { accept, isRecord, oneOf, refuse, unknownKeys } from "../ai/validate";
import type { AiValidation } from "../ai/types";
import { CATEGORY_KEYS, URGENCIES, type RequestCategory, type Urgency } from "./constants";

export interface Triage {
  category: RequestCategory;
  source: "ai" | "rules";
  urgency: Urgency;
}

export const TRIAGE_PURPOSE = "tenant_request_triage";
export const TRIAGE_MAX_INPUT = 2_400;

const CATEGORY_WORDS: [RequestCategory, RegExp][] = [
  ["air_conditioning", /\b(air ?con|a\/c|hvac|heating|cooling|too (hot|cold)|thermostat|ventilation)\b/i],
  ["plumbing", /\b(leak|leaking|toilet|tap|sink|pipe|drain|blocked|flood|water|burst|hot water|plumb)/i],
  ["electrical", /\b(power|electric|light|lights|globe|switch|outlet|socket|sparks?|fuse|breaker|tripping)\b/i],
  ["lifts", /\b(lift|lifts|elevator|escalator)\b/i],
  ["doors_locks", /\b(door|lock|locked|key|keys|fob|access card|swipe|intercom|gate|roller)\b/i],
  ["pests", /\b(pest|pests|rat|rats|mice|mouse|cockroach|ants|termite|bees|wasps?|spider)/i],
  ["cleaning", /\b(clean|cleaning|rubbish|bin|bins|spill|smell|odour|odor|toilets? paper)/i],
  ["building_fabric", /\b(wall|floor|ceiling|window|glass|carpet|tile|tiles|paint|crack|roof|stain)/i],
];

const EMERGENCY_WORDS = /\b(fire|smoke|gas|flood|flooding|burst|sparks?|sparking|electrocut|trapped|stuck in (the )?lift|exposed wire|no power|asbestos|break[- ]?in|broken into|unsafe)\b/i;
const URGENT_WORDS = /\b(leak|leaking|no water|no hot water|not working|broken|blocked|locked out|can'?t (get|open)|security|no air ?con|overflowing)\b/i;

export function rulesTriage(description: string, chosen: { category: string; urgency: string }): Triage {
  const picked = CATEGORY_WORDS.find(([, words]) => words.test(description));
  const category = (CATEGORY_KEYS.includes(chosen.category) && chosen.category !== "other" ? chosen.category : (picked?.[0] ?? "other")) as RequestCategory;
  const wording: Urgency = EMERGENCY_WORDS.test(description) ? "emergency" : URGENT_WORDS.test(description) ? "urgent" : "routine";
  // Staff see the stronger of what the tenant chose and what the words suggest.
  const rank = (u: string) => URGENCIES.indexOf(u as Urgency);
  const urgency = rank(wording) < rank(chosen.urgency) ? wording : (chosen.urgency as Urgency);
  return { category, source: "rules", urgency };
}

export function checkTriage(value: unknown): AiValidation<{ category: RequestCategory; urgency: Urgency }> {
  if (!isRecord(value)) return refuse("The answer is not a JSON object.");
  if (unknownKeys(value, ["category", "urgency"]).length > 0) return refuse("The answer has fields it should not.");
  const category = oneOf(value.category, CATEGORY_KEYS as readonly RequestCategory[]);
  const urgency = oneOf(value.urgency, URGENCIES);
  if (category === null || urgency === null) return refuse("The category or urgency is not one of the allowed values.");
  return accept({ category, urgency });
}

export const mockTriage = (input: string): string => {
  const { category, urgency } = rulesTriage(input, { category: "other", urgency: "routine" });
  return JSON.stringify({ category, urgency });
};

/** The rules' suggestion, upgraded by the model when AI is on and answers. Never throws. */
export async function suggestTriage(description: string, chosen: { category: string; urgency: string }, correlationId?: string): Promise<Triage> {
  const fallback = rulesTriage(description, chosen);
  try {
    if (!isConfigured(readAiConfig())) return fallback;
    const result = await runAi<{ category: RequestCategory; urgency: Urgency }>({
      actor: { email: null, kind: "system", name: "tenantPage", role: null, userId: null },
      correlationId,
      // Only the tenant's own words: no company, building, contact or ids go to the model.
      input: description.slice(0, TRIAGE_MAX_INPUT),
      purpose: TRIAGE_PURPOSE,
      recordType: "tenant_request",
    });
    return result.ok ? { ...result.output, source: "ai" } : fallback;
  } catch {
    return fallback;
  }
}
