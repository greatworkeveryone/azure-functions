// The request_ack template (TR1): the email that tells a tenant their request is in. It is a correspondence
// template in the procedures library (slug request-ack, seeded as a draft from the frontend's content/procedures).
// An approved (published) version is what goes out for real; a draft is used only while sends are off or a dry run,
// so a template nobody has approved never reaches a tenant.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";

export const ACK_TEMPLATE_SLUG = "request-ack";
/** What the correspondence row records as the template. */
export const ACK_TEMPLATE_ID = "request_ack";

export interface AckTemplate {
  approved: boolean;
  bodyMarkdown: string;
  subject: string;
  version: number;
}

type Block = { items?: unknown; kind?: unknown; ordered?: unknown; text?: unknown };

/** The blocks a letter can use, as the Markdown the send core renders. Anything else (diagrams, tables) is left out. */
export function blocksToMarkdown(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const raw of blocks as Block[]) {
    if (raw === null || typeof raw !== "object") continue;
    if ((raw.kind === "paragraph" || raw.kind === "heading") && typeof raw.text === "string" && raw.text.trim() !== "") {
      parts.push(raw.kind === "heading" ? `## ${raw.text.trim()}` : raw.text.trim());
    } else if ((raw.kind === "list" || raw.kind === "checklist" || raw.kind === "steps") && Array.isArray(raw.items)) {
      const ordered = raw.kind === "steps" || raw.ordered === true;
      const items = raw.items.filter((item): item is string => typeof item === "string" && item.trim() !== "");
      if (items.length > 0) parts.push(items.map((item, index) => `${ordered ? `${index + 1}.` : "-"} ${item.trim()}`).join("\n"));
    }
  }
  return parts.join("\n\n");
}

/** The published version if there is one, else the draft; null when the library has neither. */
export async function loadAckTemplate(connection: Connection): Promise<AckTemplate | null> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP (1) Title, BlocksJson, VersionNo, Status
       FROM dbo.ProcedureVersions
      WHERE Slug = @Slug AND Status IN (N'published', N'draft')
      ORDER BY CASE Status WHEN N'published' THEN 0 ELSE 1 END, VersionNo DESC`,
    [{ name: "Slug", type: TYPES.NVarChar, value: ACK_TEMPLATE_SLUG }],
  );
  const row = rows[0];
  if (!row) return null;
  let blocks: unknown = [];
  try {
    blocks = JSON.parse(String(row.BlocksJson));
  } catch {
    return null;
  }
  return { approved: row.Status === "published", bodyMarkdown: blocksToMarkdown(blocks), subject: String(row.Title), version: Number(row.VersionNo) };
}
