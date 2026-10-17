// The "What Floorplan may do in MYOB" lines of the daily email (plan M4
// review): the CFO's switches, a file's mode, pause and resume, registering a
// file, and the MYOB link. Each says who, what changed and their note.

import { darwinStamp } from "../darwinClock";
import type { ControlEvent } from "./types";

const WORDS: Record<string, string> = { dailyCap: "daily cap", dryRun: "dry run", enabled: "enabled", isDemonstration: "demonstration file", mode: "mode", requireReview: "review required" };

const value = (v: unknown) => (v === true ? "on" : v === false ? "off" : v === null || v === undefined ? "none" : String(v));

function changes(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  const keys = Object.keys(after ?? {}).filter((key) => WORDS[key] && JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])).sort();
  return keys.map((key) => `${WORDS[key]} ${value(before?.[key])} → ${value(after?.[key])}`).join(", ") || "no change";
}

function what(event: ControlEvent): string {
  const after = event.after ?? {};
  if (event.action === "myob.link") {
    const as = typeof after.myobUsername === "string" ? ` as ${after.myobUsername}` : "";
    const scope = typeof after.scope === "string" ? ` (${after.scope})` : "";
    return `${event.ruleApplied === "relink" ? "re-linked" : event.ruleApplied === "unlink" ? "unlinked" : "linked"} Floorplan to MYOB${as}${scope}`;
  }
  switch (event.ruleApplied) {
    case "pause":
      return "paused everything";
    case "resume":
      return "resumed";
    case "register":
      return `registered ${typeof after.name === "string" ? after.name : "the file"} (off)`;
    case "discover":
      return `listed by MYOB: ${typeof after.name === "string" ? after.name : "a file"} (off)`;
    case "mode":
      return changes(event.before, event.after);
    default:
      return `${event.scope ?? "control"}: ${changes(event.before, event.after)}`;
  }
}

export function controlLine(event: ControlEvent, fileName: string): string {
  const note = event.reason ? ` (${event.reason})` : "";
  return `- ${darwinStamp(event.occurredAt)} · ${event.actorName} · ${what(event)}${note} · ${fileName}`;
}
