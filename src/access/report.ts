import { TYPES, type Connection } from "tedious";
import { closeConnection, createServiceRequestConnection, executeQuery } from "../db";
import { resolveRecipient } from "../email-recipient";
import { absoluteLink } from "../escalation/config";
import { graphSendMail } from "../graph";
import { NOT_A_RECORD } from "../test-data";
import { formatDarwinDateTime } from "../ledger/darwinTime";
import { BURST_DESCRIPTION } from "./anomaly";

// The daily "unusual access" email to admin and the CFO (decision 15). Sent
// only when there is something to report. It is a plain function so lane N's
// morning digest can fold it in later; until then accessReportTimer sends it on
// its own, and only when ACCESS_REPORT_ENABLED is "true". The subject carries a
// count and nothing else, so a lock screen shows no names.

const MAX_LINES = 50;

export interface AnomalyReport {
  body: string;
  count: number;
  subject: string;
}

interface Row {
  Anomaly: string;
  At: Date;
  Country: string | null;
  DisplayName: string | null;
  Kind: string;
  LocalHour: number | null;
  Role: string | null;
}

function what(row: Row): string {
  const hour = row.LocalHour === null ? "" : ` (about ${String(row.LocalHour).padStart(2, "0")}:00 their time)`;
  switch (row.Anomaly) {
    case "new_country":
      return `used Floorplan from ${row.Country ?? "an unexpected country"}`;
    case "outside_window":
      return row.Kind === "money" ? `a money action out of hours${hour}` : `used Floorplan out of hours${hour}`;
    case "new_device":
      return "signed in from a new device or browser";
    case "burst":
      return BURST_DESCRIPTION;
    default:
      return row.Anomaly;
  }
}

export function formatAnomalyReport(rows: readonly Row[], since: Date): AnomalyReport | null {
  if (rows.length === 0) return null;
  const lines = rows.slice(0, MAX_LINES).map((row) => {
    const who = `${row.DisplayName ?? "Unknown user"}${row.Role ? ` (${row.Role})` : ""}`;
    return `- ${formatDarwinDateTime(row.At)} · ${who} · ${what(row)}`;
  });
  if (rows.length > MAX_LINES) lines.push(`- and ${rows.length - MAX_LINES} more`);
  const link = absoluteLink("/admin");
  const count = rows.length;
  return {
    body: [
      `Floorplan noticed ${count} unusual access event${count === 1 ? "" : "s"} since ${formatDarwinDateTime(since)} (Darwin time).`,
      "Nothing was blocked; this is for you to check. Expected hours and countries are set per person in Admin → Users → Access profile.",
      "",
      ...lines,
      "",
      link ? `Details: ${link} (Recent sign-ins and anomalies)` : "Details: Admin → Recent sign-ins and anomalies.",
    ].join("\n"),
    count,
    subject: `Floorplan: ${count} unusual access event${count === 1 ? "" : "s"} to review`,
  };
}

const SELECT_ANOMALIES = `SELECT e.At, e.Kind, e.Anomaly, e.Country, e.LocalHour, e.Role, u.DisplayName
  FROM dbo.AccessEvents e
  OUTER APPLY (SELECT TOP 1 DisplayName FROM dbo.AppUsers WHERE EntraOid = e.Oid) u
 WHERE e.At >= @Since AND e.Anomaly <> N'none'
 ORDER BY e.At DESC`;

/** Every anomaly since `since`, as an email; null when there were none. */
export async function buildAnomalyReport(since: Date, connection?: Connection): Promise<AnomalyReport | null> {
  const conn = connection ?? (await createServiceRequestConnection());
  try {
    const rows = await executeQuery(conn, SELECT_ANOMALIES, [{ name: "Since", type: TYPES.DateTime2, value: since }]);
    return formatAnomalyReport(rows as unknown as Row[], since);
  } finally {
    if (!connection) closeConnection(conn);
  }
}

/** Active admin and CFO addresses, after DEV_EMAIL_OVERRIDE. */
export async function anomalyReportRecipients(connection: Connection): Promise<string[]> {
  const rows = await executeQuery(
    connection,
    `SELECT Email FROM dbo.AppUsers WHERE IsActive = 1 AND Role IN (N'admin', N'cfo') AND Email IS NOT NULL`,
  );
  const addresses = rows
    .map((r) => resolveRecipient(r.Email as string | null).address)
    .filter((a): a is string => !!a);
  return [...new Set(addresses)];
}

/** Builds and sends the report for the last 24 hours. Returns what happened. */
export async function sendAnomalyReport(now: Date = new Date()): Promise<{ count: number; recipients: number; sent: boolean }> {
  const connection = await createServiceRequestConnection();
  try {
    const report = await buildAnomalyReport(new Date(now.getTime() - 24 * 60 * 60_000), connection);
    if (!report) return { count: 0, recipients: 0, sent: false };
    const recipients = await anomalyReportRecipients(connection);
    if (recipients.length === 0) return { count: report.count, recipients: 0, sent: false };
    // A report on sign-in patterns, not about a record.
    await graphSendMail(NOT_A_RECORD, recipients, report.subject, report.body);
    return { count: report.count, recipients: recipients.length, sent: true };
  } finally {
    closeConnection(connection);
  }
}
