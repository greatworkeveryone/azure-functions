import type { AuthorityFacts } from "../../approvalAuthority";
import type { Holidays } from "../../escalation/businessTime";

/** What the inventory adapters need besides the people: the clock, the holiday calendar and approval limits. */
export interface InventoryContext {
  facts: AuthorityFacts | null;
  holidays: Holidays;
  now: Date;
  today: string;
}
