// Inbound email triage (EB3): the AI step. Only when the gateway is on and this purpose is listed in
// AI_PURPOSES_ENABLED; otherwise nothing is called and no log row is written for a refusal that
// was never going to be anything else. The gateway redacts personal details, logs the call (never
// the text) and checks the answer; a refusal or a bad answer leaves the keyword reading in place.

import { readAiConfig, runAi } from "../ai";
import { buildTriageInput } from "../ai/inboundTriage/input";
import type { TriageReading } from "../ai/inboundTriage/validate";
import type { AiActor } from "../ai";
import { laneFor } from "./workInference";
import type { Work } from "./types";

export const TRIAGE_PURPOSE = "inbound_email_triage";

const SYSTEM_ACTOR: AiActor = { email: null, kind: "system", name: "Inbound email triage", role: null, userId: null };

export function aiTriageAvailable(): boolean {
  const config = readAiConfig();
  return config.enabled && config.enabledPurposes.includes(TRIAGE_PURPOSE);
}

/** The model's reading of the email, folded into a Work; null when it is not asked, refuses, or answers badly. */
export async function readWithAi(emailId: number, subject: string | null, body: string | null, fallback: Work): Promise<Work | null> {
  if (!aiTriageAvailable()) return null;
  const result = await runAi<TriageReading>({
    actor: SYSTEM_ACTOR,
    input: buildTriageInput(subject, body),
    purpose: TRIAGE_PURPOSE,
    recordId: String(emailId),
    recordType: "email",
  });
  if (!result.ok) return null;
  const reading = result.output;
  return {
    buildingName: reading.buildingName,
    category: reading.intent === "maintenance_request" ? (reading.category ?? fallback.category) : null,
    intent: reading.intent,
    jobNumber: reading.jobNumber,
    lane: laneFor(reading.intent),
    source: "ai",
    tenancyName: reading.tenancyName,
    urgency: reading.urgency ?? fallback.urgency,
  };
}
