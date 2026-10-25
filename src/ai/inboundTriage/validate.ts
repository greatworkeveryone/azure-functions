// Inbound email triage (EB3): what a model's reply has to be before anyone reads it. One JSON
// object with an intent, and optionally a category, an urgency, a job number and the names of a
// building and a tenancy. Nothing else is copied out, so a model cannot name a person, add a
// field, or send text that gets shown as anything but a short plain name. What is done with the
// answer is bounded too: it only chooses a staff lane and how to word a reason, and a job number
// or name is checked against Floorplan's own records before it is trusted (triage never trusts it
// alone, and never assigns on it alone).

import { ASSET_CATEGORIES } from "../../assetRegister";
import { INTENTS, URGENCIES, type Intent, type Urgency } from "../../inboundTriage/types";
import { NOT_ONE_LINE, NOT_PLAIN } from "../inspectionTitles/validate";
import { accept, boundedNumber, isRecord, oneOf, refuse, unknownKeys } from "../validate";
import type { AiValidation } from "../types";

export const MAX_NAME_CHARS = 120;
const KEYS = ["intent", "category", "urgency", "jobNumber", "buildingName", "tenancyName"] as const;

export interface TriageReading {
  buildingName: string | null;
  category: string | null;
  intent: Intent;
  jobNumber: number | null;
  tenancyName: string | null;
  urgency: Urgency | null;
}

function name(value: unknown, label: string): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, reason: `The ${label} is not text.` };
  const text = value.trim();
  if (text === "") return { ok: true, value: null };
  if (text.length > MAX_NAME_CHARS) return { ok: false, reason: `The ${label} is longer than ${MAX_NAME_CHARS} characters.` };
  if (NOT_ONE_LINE.test(text) || NOT_PLAIN.test(text)) return { ok: false, reason: `The ${label} is not one line of plain text.` };
  return { ok: true, value: text };
}

export function checkTriageReading(value: unknown): AiValidation<TriageReading> {
  if (!isRecord(value)) return refuse("The answer is not a JSON object.");
  if (unknownKeys(value, KEYS).length > 0) return refuse("The answer has fields it should not.");
  const intent = oneOf(value.intent, INTENTS);
  if (!intent) return refuse("The intent is missing or not one of the allowed kinds.");

  const category = value.category === undefined || value.category === null ? null : oneOf(value.category, ASSET_CATEGORIES);
  if (value.category !== undefined && value.category !== null && !category) return refuse("The category is not one of the maintenance categories.");
  const urgency = value.urgency === undefined || value.urgency === null ? null : oneOf(value.urgency, URGENCIES);
  if (value.urgency !== undefined && value.urgency !== null && !urgency) return refuse("The urgency is not one of the allowed levels.");

  let jobNumber: number | null = null;
  if (value.jobNumber !== undefined && value.jobNumber !== null) {
    jobNumber = boundedNumber(value.jobNumber, 1, 2_147_483_647);
    if (jobNumber === null || !Number.isInteger(jobNumber)) return refuse("The job number is not a whole number above zero.");
  }

  const building = name(value.buildingName, "building name");
  if (!building.ok) return refuse(building.reason);
  const tenancy = name(value.tenancyName, "tenancy name");
  if (!tenancy.ok) return refuse(tenancy.reason);

  return accept({ buildingName: building.value, category, intent, jobNumber, tenancyName: tenancy.value, urgency });
}
