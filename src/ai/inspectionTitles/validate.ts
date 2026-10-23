// Tidy job titles (SC-AI6): what a model's reply has to be before anyone reads it. A reply
// is one JSON object, {"titles": [...]}, with one plain title for each job in the input, in
// the input's order. Titles are positional: the browser puts title n on job n, so a reply
// that cannot be matched one for one is refused whole. Nothing else is copied out, so a
// model cannot add a job, a finding or a priority through this door.
//
// This proves each title is short plain text and that there is one per job, not that it
// says the same thing as the job: the prompt asks for that, and the new titles land in
// fields the person reads and can change (or undo all at once) before anything is raised.

import { jobCountOf } from "./input";
import { accept, isRecord, refuse, unknownKeys } from "../validate";
import type { AiValidation } from "../types";

export const MAX_TITLE_CHARS = 80;

/** Markup, code, a link or a bracket: a title is plain words. */
export const NOT_PLAIN = /[<>`*#[\]{}]|:\/\//;
/** Control characters, tabs and breaks, and the characters that hide or reorder text: a title is one visible line. */
export const NOT_ONE_LINE = /[\0-\x1f\x7f\x85\u{2028}\u{2029}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/u;

export interface JobTitles {
  titles: string[];
}

/**
 * Given the input the provider was sent (the gateway hands it over). With no readable input
 * there are no jobs, so the only answer that passes is an empty list: such a check fails closed.
 */
export function checkJobTitles(value: unknown, input?: string): AiValidation<JobTitles> {
  if (!isRecord(value)) return refuse("The answer is not a JSON object.");
  if (unknownKeys(value, ["titles"]).length > 0 || !("titles" in value)) return refuse("The answer has fields it should not, or no titles.");
  if (!Array.isArray(value.titles)) return refuse("The titles are not a list.");

  const jobs = jobCountOf(input);
  if (value.titles.length !== jobs) return refuse(`The answer has ${value.titles.length} titles for ${jobs} jobs.`);

  const titles: string[] = [];
  for (const [index, raw] of value.titles.entries()) {
    if (typeof raw !== "string") return refuse(`Title ${index + 1} is not text.`);
    const title = raw.trim();
    if (title === "" || title.length > MAX_TITLE_CHARS) return refuse(`Title ${index + 1} is empty or longer than ${MAX_TITLE_CHARS} characters.`);
    if (NOT_ONE_LINE.test(title)) return refuse(`Title ${index + 1} is not on one line of visible text.`);
    if (NOT_PLAIN.test(title)) return refuse(`Title ${index + 1} holds markup, a link or a bracket.`);
    titles.push(title);
  }
  return accept({ titles });
}
