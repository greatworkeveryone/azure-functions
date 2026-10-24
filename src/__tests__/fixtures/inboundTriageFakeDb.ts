// A fake database for this module's tests: answers each statement by what it reads or writes, and
// records every write, so a test can say what was inserted and updated without a server.
import type { StaffRow } from "../../inboundTriage/load";

export interface FakeState {
  accessLogStart: Date | null;
  assignmentRaces: boolean;
  contractors: { ContractorID: number }[];
  jobs: Record<string, unknown>[];
  lastActive: Record<number, Date>;
  leave: number[];
  namedJob: Record<string, unknown> | null;
  staff: StaffRow[];
  staffByEmail: boolean;
  tenancies: Record<string, unknown>[];
  writes: { params: Record<string, unknown>; sql: string }[];
}

export const freshState = (): FakeState => ({
  accessLogStart: null, assignmentRaces: false, contractors: [], jobs: [], lastActive: {}, leave: [], namedJob: null, staff: [], staffByEmail: false, tenancies: [], writes: [],
});

const asParams = (call: unknown[]): Record<string, unknown> =>
  Object.fromEntries(((call[2] as { name: string; value: unknown }[]) ?? []).map((param) => [param.name, param.value]));

/** executeQuery's implementation over `state`. Unknown statements answer no rows. */
export function fakeExecute(state: FakeState) {
  let nextSet = 100;
  return async (...call: unknown[]): Promise<Record<string, unknown>[]> => {
    const sql = String(call[1]);
    const params = asParams(call);
    if (/FROM dbo\.AppUsers\s+WHERE IsActive = 1 AND \(Role IN/.test(sql)) {
      return state.staff.map((person) => ({ DisplayName: person.name, Role: person.role, UserID: person.userId }));
    }
    if (/FROM dbo\.LeaveRequests/.test(sql)) return state.leave.map((UserId) => ({ UserId }));
    if (/MIN\(At\) AS FirstAt/.test(sql)) return [{ FirstAt: state.accessLogStart }];
    if (/MAX\(e\.At\) AS LastAt/.test(sql)) return Object.entries(state.lastActive).map(([UserID, LastAt]) => ({ LastAt, UserID: Number(UserID) }));
    if (/FROM dbo\.Tenants\s+WHERE \(PrimaryContactEmail/.test(sql)) return state.tenancies;
    if (/FROM dbo\.Contractors WHERE EmailAddress/.test(sql)) return state.contractors;
    if (/FROM dbo\.AppUsers WHERE Email = @Address/.test(sql)) return state.staffByEmail ? [{ UserID: 1 }] : [];
    if (/FROM dbo\.Jobs WHERE JobID = @JobId/.test(sql)) return state.namedJob ? [state.namedJob] : [];
    if (/FROM dbo\.Jobs\s+WHERE AssignedToUserID IN/.test(sql)) return state.jobs;
    if (/FROM dbo\.Buildings WHERE BuildingID = @Id/.test(sql)) return [{ BuildingName: "Frogmore House" }];
    if (/FROM dbo\.Tenants WHERE TenantId = @Id/.test(sql)) return [{ BuildingId: 10, Name: "Acme Pty Ltd" }];
    if (/INSERT INTO dbo\.EmailRoutingSets/.test(sql)) {
      state.writes.push({ params, sql });
      return [{ SetId: nextSet++ }];
    }
    if (/UPDATE dbo\.Emails\s+SET AssignedToUserId/.test(sql)) {
      state.writes.push({ params, sql });
      return state.assignmentRaces ? [] : [{ EmailID: params.EmailId }];
    }
    if (/^\s*(INSERT|UPDATE)/i.test(sql)) state.writes.push({ params, sql });
    return [];
  };
}
