// The email itself (N1). Plain text, because Graph is sent as Text and the link
// is the point. The subject says how many things need the person and nothing
// about them: it shows on a lock screen, so no amounts, tenant names or job
// titles ever reach it.

import { DIGEST_MAX_LINES } from "./config";
import { formatDisplayDate } from "./format";
import { pickLines } from "./items";
import type { DigestItem, DigestUser } from "./types";

export { formatDisplayDate } from "./format";

export interface DigestEmailOptions {
  /** APP_BASE_URL; null gives relative paths (a dry run without it set). */
  baseUrl: string | null;
  maxLines?: number;
  /** The real address when DEV_EMAIL_OVERRIDE redirected this email. */
  overriddenFrom: string | null;
  /** The Darwin date, YYYY-MM-DD. */
  today: string;
}

function link(baseUrl: string | null, path: string): string {
  return baseUrl === null ? path : `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function firstName(user: DigestUser): string {
  return user.name.trim().split(/\s+/)[0] || "there";
}

export function buildDigestEmail(
  user: DigestUser,
  items: readonly DigestItem[],
  options: DigestEmailOptions,
): { body: string; subject: string } {
  const total = items.length;
  const { more, shown } = pickLines(items, options.maxLines ?? DIGEST_MAX_LINES);
  const subject = `Floorplan ${formatDisplayDate(options.today)}: ${total} ${total === 1 ? "item needs" : "items need"} you`;

  const lines = ["Good morning " + firstName(user) + ",", "", `${total} ${total === 1 ? "thing needs" : "things need"} you in Floorplan today.`, ""];
  for (const item of shown) lines.push(`- ${item.line}`, `  ${link(options.baseUrl, item.path)}`);
  if (more > 0) lines.push("", `and ${more} more: ${link(options.baseUrl, "/dashboard")}`);
  lines.push(
    "",
    'You only get this email on mornings when something needs you. To stop it, switch off "Morning digest email" in the user menu in Floorplan.',
  );
  if (options.overriddenFrom) lines.push("", `(Redirected by DEV_EMAIL_OVERRIDE; this was meant for ${options.overriddenFrom}.)`);
  return { body: `${lines.join("\n")}\n`, subject };
}
