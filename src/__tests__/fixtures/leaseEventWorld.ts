// An in-memory database for the lease event endpoint tests (WP32, WP33): just
// the tables and statements those endpoints use, routed by SQL text, with
// transactions that really roll back (a snapshot on begin, restored on
// rollback), so a test can prove an APPLY is all-or-nothing.

import { TODAY, asDate } from "./rentReviewFakes";

export type Row = Record<string, unknown>;
type Param = { name: string; value: unknown };

export interface WorldState {
  changeLog: Row[];
  events: Row[];
  ledger: Row[];
  reviews: Row[];
  tenancy: Row;
  vacancies: Row[];
}

let versionCounter = 0x0a00;
const nextVersion = (): Buffer => Buffer.from((++versionCounter).toString(16).padStart(16, "0"), "hex");

export function tenancyRow(over: Row = {}): Row {
  return {
    ArchivedAt: null,
    BuildingId: 3,
    BuildingName: "Tower A",
    Commencement: asDate("2022-07-01"),
    Expiry: asDate("2027-06-30"),
    FixedReviewPercent: 3,
    HoldoverTerms: null,
    IsTest: false,
    LastReviewDate: asDate("2026-07-01"),
    LegalName: "Acme Pty Ltd",
    NextReviewDate: asDate("2027-07-01"),
    OptionNoticeMonths: 6,
    OptionPeriods: "2 x 5 years",
    OptionTermMonths: null,
    OptionsRemaining: null,
    OptionsTotal: null,
    RentPerAnnum: 100000,
    ResolvedReviewDates: null,
    ReviewIntervalMonths: 12,
    ReviewType: "Fixed 3%",
    ScheduleSignedOffAt: new Date("2026-08-01T00:00:00Z"),
    ScheduleSignedOffById: 1,
    ScheduleSignedOffByName: "Bo Manager",
    ScheduleSignOffNote: null,
    ScheduleVersion: 4,
    ScheduledRateSteps: JSON.stringify([
      { baseRentPerAnnum: 100000, effectiveFrom: "2022-07-01", effectiveTo: "2023-07-01", id: "s0", methodKind: "commencement", ratePercent: 0 },
      { effectiveFrom: "2023-07-01", id: "s1", methodKind: "fixed", ratePercent: 3, resolution: "applied" },
    ]),
    Status: "current",
    TenantId: 7,
    TradingName: null,
    UpdatedAt: new Date("2026-08-01T00:00:00Z"),
    ...over,
  };
}

export function eventRow(over: Row = {}): Row {
  return {
    ArchivedAt: null,
    BuildingId: 3,
    CreatedAt: new Date("2026-09-01T00:00:00Z"),
    DeadlineOn: asDate("2026-12-30"),
    DecidedAt: null,
    DecidedById: null,
    DecidedByName: null,
    LateNotice: false,
    LeaseEventId: "ev-1",
    LeaseExpiry: asDate("2027-06-30"),
    NoticeDate: null,
    NoticeDocument: null,
    Outcome: null,
    OutcomeDetails: null,
    OutcomeReason: null,
    RecordedAt: null,
    RecordedById: null,
    RecordedByName: null,
    State: "window_open",
    TenantId: 7,
    Terms: null,
    Type: "option_exercise",
    UpdatedAt: new Date("2026-09-01T00:00:00Z"),
    Version: nextVersion(),
    WindowOpensOn: asDate("2026-06-30"),
    ...over,
  };
}

const clone = <T>(value: T): T => {
  const copy = (v: unknown): unknown => {
    if (Buffer.isBuffer(v)) return Buffer.from(v);
    if (v instanceof Date) return new Date(v.getTime());
    if (Array.isArray(v)) return v.map(copy);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
    return v;
  };
  return copy(value) as T;
};

const dateOf = (value: unknown): unknown => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? asDate(value) : value);

export class LeaseEventWorld {
  state: WorldState;
  private snapshot: WorldState | null = null;
  /** A ledger action whose INSERT fails, to test a rollback. */
  failLedgerAction: string | null = null;

  constructor(tenancy: Row = tenancyRow(), events: Row[] = []) {
    this.state = { changeLog: [], events, ledger: [], reviews: [], tenancy, vacancies: [] };
  }

  begin(): void {
    this.snapshot = clone(this.state);
  }

  commit(): void {
    this.snapshot = null;
  }

  rollback(): void {
    if (this.snapshot) this.state = this.snapshot;
    this.snapshot = null;
  }

  event(id = "ev-1"): Row | undefined {
    return this.state.events.find((event) => event.LeaseEventId === id);
  }

  versionOf(id = "ev-1"): string {
    return (this.event(id)?.Version as Buffer).toString("hex");
  }

  private withTenant(event: Row): Row {
    const t = this.state.tenancy;
    return { ...event, IsTest: undefined, LegalName: t.LegalName, TenantArchivedAt: t.ArchivedAt, TenantIsTest: t.IsTest, TenantStatus: t.Status, TradingName: t.TradingName };
  }

  query(sql: string, params: Param[] = []): Row[] {
    const p = Object.fromEntries(params.map((x) => [x.name, x.value]));
    const OPEN = ["window_not_open", "window_open", "notice_received", "awaiting_approval", "referred"];
    if (/FROM dbo\.Tenants t( WITH \(UPDLOCK, ROWLOCK\))? LEFT JOIN dbo\.Buildings/.test(sql)) {
      return p.TenantId === this.state.tenancy.TenantId ? [clone(this.state.tenancy)] : [];
    }
    if (sql.includes("INSERT INTO dbo.DecisionLedger")) {
      if (this.failLedgerAction && p.Action === this.failLedgerAction) throw new Error(`ledger write failed for ${p.Action}`);
      this.state.ledger.push(p);
      return [];
    }
    if (sql.includes("FROM dbo.LeaseEvents e")) {
      let rows = this.state.events;
      if (sql.includes("e.LeaseEventId = @LeaseEventId")) rows = rows.filter((e) => e.LeaseEventId === p.LeaseEventId);
      else if (sql.includes("e.State = 'lapsed' AND e.LeaseExpiry = @LeaseExpiry")) {
        rows = rows.filter((e) => e.TenantId === p.TenantId && e.Type === "option_exercise" && e.State === "lapsed" && String((e.LeaseExpiry as Date).toISOString()).slice(0, 10) === String((dateOf(p.LeaseExpiry) as Date).toISOString()).slice(0, 10));
      } else if (sql.includes("e.Type = @Type AND e.State IN")) rows = rows.filter((e) => e.TenantId === p.TenantId && e.Type === p.Type && OPEN.includes(String(e.State)));
      else if (sql.includes("e.TenantId = @TenantId")) rows = rows.filter((e) => e.TenantId === p.TenantId);
      return rows.map((e) => this.withTenant(clone(e)));
    }
    if (sql.includes("INSERT INTO dbo.LeaseEvents")) {
      this.state.events.push(
        eventRow({
          BuildingId: p.BuildingId,
          CreatedAt: new Date(),
          DeadlineOn: dateOf(p.DeadlineOn) ?? null,
          LeaseEventId: p.LeaseEventId,
          LeaseExpiry: dateOf(p.LeaseExpiry) ?? null,
          State: p.State,
          TenantId: p.TenantId,
          Type: p.Type,
          WindowOpensOn: dateOf(p.WindowOpensOn) ?? null,
        }),
      );
      return [];
    }
    if (sql.includes("UPDATE dbo.LeaseEvents")) {
      const from = Object.entries(p).filter(([k]) => /^From\d+$/.test(k)).map(([, v]) => v);
      const event = this.state.events.find((e) => e.LeaseEventId === p.LeaseEventId && from.includes(e.State));
      if (!event) return [];
      event.State = p.To;
      for (const column of ["NoticeDocument", "LateNotice", "Terms", "RecordedById", "RecordedByName", "Outcome", "OutcomeDetails", "OutcomeReason", "DecidedById", "DecidedByName"]) {
        if (column in p) event[column] = p[column];
      }
      if ("NoticeDate" in p) event.NoticeDate = dateOf(p.NoticeDate);
      if ("Reason" in p) event.OutcomeReason = p.Reason;
      if (sql.includes("RecordedAt = SYSUTCDATETIME()")) event.RecordedAt = new Date();
      if (/DecidedAt = SYSUTCDATETIME\(\)/.test(sql)) event.DecidedAt = new Date();
      if (sql.includes("Outcome = NULL")) Object.assign(event, { DecidedAt: null, DecidedById: null, DecidedByName: null, Outcome: null });
      const literal = sql.match(/Outcome = '(\w+)'/);
      if (literal) event.Outcome = literal[1];
      event.Version = nextVersion();
      return [{ LeaseEventId: event.LeaseEventId }];
    }
    if (sql.includes("UPDATE dbo.Tenants")) {
      const t = this.state.tenancy;
      const map: Record<string, string> = {
        Commencement: "Commencement", Expiry: "Expiry", FixedReviewPercent: "FixedReviewPercent", HoldoverTerms: "HoldoverTerms",
        NextReviewDate: "NextReviewDate", OptionPeriods: "OptionPeriods", OptionTermMonths: "OptionTermMonths", OptionsRemaining: "OptionsRemaining",
        OptionsTotal: "OptionsTotal", ReviewIntervalMonths: "ReviewIntervalMonths", ReviewType: "ReviewType", Steps: "ScheduledRateSteps",
      };
      for (const [param, column] of Object.entries(map)) if (param in p) t[column] = dateOf(p[param]);
      if (sql.includes("OptionsRemaining = @OptionsTotal")) t.OptionsRemaining = p.OptionsTotal;
      if (sql.includes("Count")) Object.assign(t, { OptionTermMonths: p.TermMonths, OptionsRemaining: p.Count, OptionsTotal: p.Count });
      const status = sql.match(/Status = '(\w+)'/);
      if (status) t.Status = status[1];
      if (sql.includes("ScheduleVersion = ScheduleVersion + 1")) t.ScheduleVersion = Number(t.ScheduleVersion) + 1;
      return [{ ScheduleVersion: t.ScheduleVersion, TenantId: t.TenantId }];
    }
    if (sql.includes("INSERT INTO dbo.RentScheduleChangeLog")) {
      this.state.changeLog.push(p);
      return [];
    }
    if (sql.includes("FROM dbo.RentReviews WITH (UPDLOCK, ROWLOCK)")) {
      return this.state.reviews.filter((r) => r.TenantId === p.TenantId && ["scheduled", "due", "in_progress", "awaiting_index", "referred", "awaiting_approval"].includes(String(r.State)));
    }
    if (sql.includes("INSERT INTO dbo.RentReviews")) {
      this.state.reviews.push({ Method: p.Method, ReviewId: p.ReviewId, ScheduledFor: dateOf(p.ScheduledFor), State: "scheduled", TenantId: p.TenantId });
      return [];
    }
    if (sql.includes("INSERT INTO dbo.Vacancies")) {
      const id = this.state.vacancies.length + 101;
      this.state.vacancies.push({ ...p, Id: id });
      return [{ Id: id }];
    }
    return [];
  }

  ledgerActions(): string[] {
    return this.state.ledger.map((row) => String(row.Action));
  }
}

/** Wires the mocked db module to a world. */
export function useLeaseWorld(get: () => LeaseEventWorld, db: Record<string, jest.Mock>): void {
  db.createRequestConnection.mockResolvedValue({});
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string, params: Param[]) => get().query(sql, params));
  db.beginTransaction.mockImplementation(async () => get().begin());
  db.commitTransaction.mockImplementation(async () => get().commit());
  db.rollbackTransaction.mockImplementation(async () => get().rollback());
}

export { TODAY };
