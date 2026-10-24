// The work waiting on the people who are away: one adapter per source, each
// selecting positively (exactly these people's items), each with a due date and an
// importance. Adding a source is adding an adapter here.

import type { Connection } from "tedious";
import type { ReportingLink, StaffMember } from "../../leavePolicy";
import type { AbsentPerson, CoverItem } from "../types";
import { loadApprovalItems } from "./approvals";
import type { InventoryContext } from "./context";
import { loadDecisionItems } from "./decisions";
import { loadEmailItems, type EmailColumns } from "./emails";
import { loadEscalationItems } from "./escalations";
import { loadJobItems } from "./jobs";
import { loadLeaveApprovalItems } from "./leaveApprovals";

export interface InventoryInput {
  absent: readonly AbsentPerson[];
  context: InventoryContext;
  emailColumns: EmailColumns;
  links: readonly ReportingLink[];
  staff: readonly StaffMember[];
}

export async function loadInventory(connection: Connection, input: InventoryInput): Promise<CoverItem[]> {
  const ids = input.absent.map((person) => person.userId);
  const absentIds = new Set(ids);
  return [
    ...(await loadJobItems(connection, ids)),
    ...(await loadDecisionItems(connection, absentIds)),
    ...(await loadEscalationItems(connection, ids)),
    ...(await loadApprovalItems(connection, input.absent, input.context)),
    ...(await loadEmailItems(connection, ids, input.emailColumns, input.context)),
    ...(await loadLeaveApprovalItems(connection, absentIds, input.staff, input.links)),
  ];
}
