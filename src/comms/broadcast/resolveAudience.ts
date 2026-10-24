// resolveBroadcastAudience's work: read what the request selects and combine it (audienceResolve.ts).
// The reads run one after another: a tedious connection serves one request at a time.

import type { Connection } from "tedious";
import { loadAssignedContractors, loadContractors, loadContractorTrades, loadOccupancies, loadStaff, loadTenancies, loadTestContactAddresses } from "./audienceLoad";
import { combine, resolveContractors, resolveStaff, resolveTenancies, resolveTyped, withoutTestContacts } from "./audienceResolve";
import type { AudienceRequest, ResolvedAudience } from "./types";

export async function resolveAudience(connection: Connection, request: AudienceRequest): Promise<ResolvedAudience> {
  const outcomes = [];
  if (request.tenancies) {
    const buildingIds = request.tenancies.selections.map((selection) => selection.buildingId);
    const tenancies = await loadTenancies(connection, buildingIds);
    const occupancies = await loadOccupancies(connection, buildingIds);
    outcomes.push(resolveTenancies(request.tenancies, { occupancies, tenancies }));
  }
  if (request.contractors) {
    const contractors = await loadContractors(connection);
    const profiles = await loadContractorTrades(connection);
    const assignedAtBuildings = await loadAssignedContractors(connection, request.contractors.buildingIds, request.contractors.trades);
    outcomes.push(resolveContractors(request.contractors, { assignedAtBuildings, contractors, profiles }));
  }
  if (request.staff) outcomes.push(resolveStaff(await loadStaff(connection, request.staff.roles)));
  if (request.typed.length > 0) outcomes.push(withoutTestContacts(resolveTyped(request.typed), await loadTestContactAddresses(connection)));
  return combine(outcomes);
}
