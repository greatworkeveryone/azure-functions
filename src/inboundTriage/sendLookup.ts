// Inbound email triage (EB3): the one door to EB1's stored sends.
//
// EB1 (send core, migration 108) stores the internet message id of every message it drafts on the
// recipient's row. This module is the whole of what EB3 asks of it: given the ids an incoming email
// names in In-Reply-To and References, which send, if any, did it answer? The answer is the recipient
// row's job (who sent it, its kind and subject) and, for a tenancy recipient, the tenancy and its building.
//
// `ids` are normalised: no angle brackets, lower case, nearest ancestor last (the order of the
// References header). Graph stores the id with its brackets and in the sender's case, so the query
// asks for both spellings (the column is compared case-insensitively) and the nearest match wins.
// A reply names a message that was drafted, not necessarily one EB1 saw sent: a recipient left
// "send_unconfirmed" whose reply arrives proves the send happened, so no status is required.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { normaliseMessageId } from "./messageIds";
import type { LinkedSend } from "./types";

export type FindSendByInternetMessageId = (connection: Connection, ids: readonly string[]) => Promise<LinkedSend | null>;

const LOOKUP_SQL = `SELECT r.InternetMessageId, r.Address, r.RecipientType, c.CorrespondenceId, c.Kind, c.Subject, t.TenantId, t.BuildingId, u.UserID AS SentByUserId
  FROM dbo.CorrespondenceRecipients r
  JOIN dbo.Correspondence c ON c.CorrespondenceId = r.CorrespondenceId
  LEFT JOIN dbo.Tenants t ON r.RecipientType = 'tenancy' AND t.TenantId = TRY_CAST(r.RecipientRefId AS INT)
  LEFT JOIN dbo.AppUsers u ON u.EntraOid = c.CreatedByOid
  WHERE r.InternetMessageId IN (SELECT [value] FROM OPENJSON(@Ids))`;

const optionalNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export const findSendByInternetMessageId: FindSendByInternetMessageId = async (connection, ids) => {
  const wanted = ids.map(normaliseMessageId).filter((id) => id !== "");
  if (wanted.length === 0) return null;
  const spellings = [...new Set(wanted.flatMap((id) => [id, `<${id}>`]))];
  const rows = await executeQuery(connection, LOOKUP_SQL, [{ name: "Ids", type: TYPES.NVarChar, value: JSON.stringify(spellings) }]);

  let best: { rank: number; row: (typeof rows)[number] } | null = null;
  for (const row of rows) {
    const rank = wanted.lastIndexOf(normaliseMessageId(String(row.InternetMessageId ?? "")));
    if (rank >= 0 && (best === null || rank > best.rank)) best = { rank, row };
  }
  if (best === null) return null;
  const { row } = best;
  return {
    buildingId: optionalNumber(row.BuildingId),
    jobId: null,
    kind: String(row.Kind),
    recipientEmail: (row.Address as string | null) ?? null,
    sendId: String(row.CorrespondenceId),
    sentByUserId: optionalNumber(row.SentByUserId),
    subject: (row.Subject as string | null) ?? null,
    tenancyId: optionalNumber(row.TenantId),
  };
};
