// Inbound email triage (EB3): the stand-in for a model (AI_PROVIDER=mock). Deterministic, no
// network: it reads the email the way the keyword rules do, plus a job number when the text names
// one. Its text goes through the same answer checks as a real model's.

import { jobIdFromText } from "../../email/job-ref";
import { rulesWork } from "../../inboundTriage/workInference";
import { readTriageInput } from "./input";

export function mockTriageReading(input: string): string {
  const { body, subject } = readTriageInput(input);
  const work = rulesWork(subject, body);
  return JSON.stringify({
    buildingName: null,
    category: work.category,
    intent: work.intent,
    jobNumber: jobIdFromText(subject, body),
    tenancyName: null,
    urgency: work.urgency,
  });
}
