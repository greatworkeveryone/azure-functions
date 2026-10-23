// Tidy job titles (SC-AI6): the body tidyInspectionJobTitles accepts, checked before
// anything else happens. The browser sends the titles a person is looking at and the
// findings each job was made from; the server takes only that text, never an id.

import { boundedString, isRecord } from "../validate";
import { buildTitlesInput, TIDY_LIMITS, type TidyJob } from "./input";

export interface TidyTitlesRequest {
  jobs: TidyJob[];
}

function readJob(raw: unknown, position: number): TidyJob | string {
  const which = `Job ${position}`;
  if (!isRecord(raw)) return `${which} must be an object with a title.`;
  const title = boundedString(raw.title, TIDY_LIMITS.titleChars)?.trim();
  if (!title) return `${which} needs a title of up to ${TIDY_LIMITS.titleChars} characters.`;

  const given = raw.findings === undefined ? [] : raw.findings;
  if (!Array.isArray(given) || given.length > TIDY_LIMITS.maxFindings) {
    return `${which} can have up to ${TIDY_LIMITS.maxFindings} findings.`;
  }
  const findings: string[] = [];
  for (const finding of given) {
    const text = boundedString(finding, TIDY_LIMITS.findingChars)?.trim();
    if (!text) return `Each finding of ${which.toLowerCase()} needs text of up to ${TIDY_LIMITS.findingChars} characters.`;
    findings.push(text);
  }
  return { findings, title };
}

/** The jobs to tidy, or the plain sentence that says what is wrong. */
export function parseTidyTitlesBody(body: unknown): TidyTitlesRequest | { error: string } {
  if (!isRecord(body)) return { error: "Send the job titles to tidy." };
  if (!Array.isArray(body.titles) || body.titles.length < 1 || body.titles.length > TIDY_LIMITS.maxTitles) {
    return { error: `Send between 1 and ${TIDY_LIMITS.maxTitles} job titles to tidy.` };
  }
  const jobs: TidyJob[] = [];
  for (const [index, raw] of body.titles.entries()) {
    const job = readJob(raw, index + 1);
    if (typeof job === "string") return { error: job };
    jobs.push(job);
  }
  if (buildTitlesInput(jobs).length > TIDY_LIMITS.maxInputChars) {
    return { error: "That is more text than can be tidied at once. Send fewer jobs, or fewer and shorter findings." };
  }
  return { jobs };
}
