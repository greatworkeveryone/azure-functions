// The absence_cover adapter (AW1, PLAN §13): the in-app notice a cover gets when work
// is moved to them while someone is away (policy cover.moved, seeded by migration 177).
// The subject is the ledger row (dbo.CoverActions) that records the move, so a notice
// is exactly one move. It stays in the cover's For you list until they resolve it, and
// ends by itself when the move is taken back. It decides nothing: the item it points at
// is opened from the deep link, and nothing is ever approved by being told.

import { TYPES } from "tedious";
import { executeQuery } from "../../db";
import { normaliseRole, ROLES } from "../roles";
import type { EscalationAdapter } from "./registry";

export const ABSENCE_COVER_SUBJECT = "absence_cover";

// Everyone who can open the inbox, except admin: a notice about work moved to a cover is for them.
const VIEWERS: ReadonlySet<string> = new Set([
  ROLES.accounts,
  ROLES.accountsManager,
  ROLES.cfo,
  ROLES.director,
  ROLES.facilities,
  ROLES.facilitiesManager,
]);

const idOf = (subjectId: string): number | null => (/^\d{1,15}$/.test(subjectId) ? Number(subjectId) : null);

export const absenceCoverAdapter: EscalationAdapter = {
  subjectType: ABSENCE_COVER_SUBJECT,

  deepLink: (_subjectId, row) => {
    const link = row?.context?.deepLink;
    return typeof link === "string" && link.startsWith("/") ? link : "/covering";
  },

  // True until the move is taken back: a taken_back row names the move it undoes.
  async isConditionActive(connection, ref) {
    const id = idOf(ref.subjectId);
    if (id === null) return false;
    const rows = await executeQuery(
      connection,
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM dbo.CoverActions WHERE CoverActionId = @Id)
                    AND NOT EXISTS (SELECT 1 FROM dbo.CoverActions WHERE RelatedActionId = @Id AND Action = N'taken_back')
                   THEN 1 ELSE 0 END AS Active`,
      [{ name: "Id", type: TYPES.BigInt, value: id }],
    );
    return Number(rows[0]?.Active) === 1;
  },

  async loadSummary(connection, subjectId) {
    const id = idOf(subjectId);
    if (id === null) return null;
    const rows = await executeQuery(
      connection,
      `SELECT c.ItemType, c.ItemId, c.ItemLabel, c.ReasonText, u.DisplayName AS FromName, CONVERT(VARCHAR(10), c.ReturnDate, 23) AS ReturnDate
         FROM dbo.CoverActions c
         INNER JOIN dbo.AppUsers u ON u.UserID = c.FromUserId
        WHERE c.CoverActionId = @Id AND c.Action IN (N'reassigned', N'escalated')`,
      [{ name: "Id", type: TYPES.BigInt, value: id }],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      buildingId: null,
      context: {
        coverActionId: id,
        fromName: String(row.FromName),
        itemId: String(row.ItemId),
        itemType: String(row.ItemType),
        returnDate: typeof row.ReturnDate === "string" ? row.ReturnDate : null,
      },
      summary: `Covering for ${row.FromName}: ${row.ItemLabel}`.slice(0, 400),
    };
  },

  visibleTo: (viewer) => viewer.roles.some((role) => VIEWERS.has(normaliseRole(role))),
};
