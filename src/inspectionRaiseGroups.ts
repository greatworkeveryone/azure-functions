// Raising jobs from an inspection with the groups a person reviewed (SC-AI6).
//
// raiseJobsFromInspection takes either PointIds with a Mode (one job per finding, or
// per room) or Groups: each group is one job, with its own title and priority. The
// browser works the groups out from the findings it was shown and a person edits
// them; this file only checks the request's shape. Which findings exist, what the job
// says about them and who it is for still come from the database in the route.

import { JOB_PRIORITIES, type JobPriority } from "./jobPriorities";

export const MAX_RAISE_GROUPS = 100;
export const MAX_POINTS_PER_GROUP = 500;
export const MAX_GROUP_TITLE_CHARS = 200;
const MAX_POINT_ID_CHARS = 100;

/** One job to create: its findings in the order given, and what the person chose for it. */
export interface RaiseGroup {
  pointIds: string[];
  priority?: JobPriority;
  title?: string;
}

// Tabs and line breaks too: a job's title is one line.
const CONTROL = /[\u0000-\u001f\u007f]/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readGroup(raw: unknown, position: number): RaiseGroup | string {
  const which = `Job ${position}`;
  if (!isRecord(raw)) return `${which} must be an object with PointIds.`;

  const ids = raw.PointIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_POINTS_PER_GROUP) {
    return `${which} needs between 1 and ${MAX_POINTS_PER_GROUP} findings.`;
  }
  if (!ids.every((id) => typeof id === "string" && id.trim() !== "" && id.length <= MAX_POINT_ID_CHARS)) {
    return `${which} has a finding id that is not short text.`;
  }
  const group: RaiseGroup = { pointIds: [...new Set(ids as string[])] };

  if (raw.Priority !== undefined && raw.Priority !== null) {
    if (!JOB_PRIORITIES.includes(raw.Priority as JobPriority)) {
      return `${which} has a priority that is not ${JOB_PRIORITIES.join(", ")}.`;
    }
    group.priority = raw.Priority as JobPriority;
  }

  if (raw.Title !== undefined && raw.Title !== null) {
    const title = typeof raw.Title === "string" ? raw.Title.trim() : "";
    if (title === "" || title.length > MAX_GROUP_TITLE_CHARS || CONTROL.test(title)) {
      return `${which} needs a title of 1 to ${MAX_GROUP_TITLE_CHARS} characters on one line.`;
    }
    group.title = title;
  }
  return group;
}

/** The groups of a request, or the plain sentence that says what is wrong with them. */
export function parseRaiseGroups(raw: unknown): { groups: RaiseGroup[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RAISE_GROUPS) {
    return { error: `Send between 1 and ${MAX_RAISE_GROUPS} jobs in Groups.` };
  }
  const groups: RaiseGroup[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const group = readGroup(item, index + 1);
    if (typeof group === "string") return { error: group };
    for (const id of group.pointIds) {
      if (seen.has(id)) return { error: "A finding can only go into one job." };
      seen.add(id);
    }
    groups.push(group);
  }
  return { groups };
}

/** `text` within `max` characters: cut at a word where there is one, and ended with … to show it was cut. */
export function fitText(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - 1;
  let cut = text.slice(0, room);
  if (text[room] !== " ") {
    const space = cut.lastIndexOf(" ");
    if (space > 0) cut = cut.slice(0, space);
  }
  return `${cut.replace(/[\s,;:–—-]+$/, "")}…`;
}

/** The title a person chose, after the batch's prefix when it has one, as a job title (the column holds 200). */
export function composeGroupTitle(prefix: string, title: string): string {
  return fitText(prefix ? `${prefix} ${title}` : title, MAX_GROUP_TITLE_CHARS);
}

/** Each name once, in the order first met, joined for one text column and cut to fit it. */
export function joinDistinct(names: readonly string[], max: number): string {
  return fitText([...new Set(names)].join(", "), max);
}
