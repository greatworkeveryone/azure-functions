// An in-memory stand-in for the database behind the WP26 rent review endpoints:
// RentReviews (with the one-open-review unique index), Tenants, the schedule
// change log, the decision ledger, CpiIndex, occupancies and the live E3 lookup.
// It answers the SQL the code sends by its shape, applies UPDATE ... SET
// clauses column by column, and snapshots itself on beginTransaction so a
// rollback really restores every table: tests prove "all or nothing" against
// what was stored, not just against the calls made. Unknown SQL fails loudly.

type Row = Record<string, unknown>;
type Param = { name: string; value: unknown };

const OPEN = ["scheduled", "due", "in_progress", "awaiting_index", "referred", "awaiting_approval"];
const asIso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "string" ? value.slice(0, 10) : null;

export interface WorldState {
  changeLog: Row[];
  cpi: Row[];
  escalations: Row[];
  ledger: Row[];
  occupancySqm: Record<number, number>;
  reviews: Row[];
  tenants: Row[];
}

export class ReviewWorld {
  state: WorldState = { changeLog: [], cpi: [], escalations: [], ledger: [], occupancySqm: {}, reviews: [], tenants: [] };
  private snapshot: string | null = null;
  private version = 0xa01;
  private ledgerId = 1;
  /** Throw on the ledger INSERT whose row this returns true for (an injected failure). */
  failLedger: ((row: Row) => boolean) | null = null;
  /** Throw this error on the statement it returns one for (a deadlock, a unique-index race). */
  failSql: ((sql: string) => Error | null) | null = null;
  /** Every statement, in order, for assertions about what ran. */
  log: string[] = [];
  committed = 0;
  rolledBack = 0;

  nextVersion(): string {
    this.version += 1;
    return this.version.toString(16).padStart(16, "0");
  }

  begin(): void {
    this.snapshot = JSON.stringify({ ...this.state, version: this.version, ledgerId: this.ledgerId });
  }

  commit(): void {
    this.snapshot = null;
    this.committed += 1;
  }

  rollback(): void {
    if (this.snapshot) {
      const saved = JSON.parse(this.snapshot) as WorldState & { ledgerId: number; version: number };
      this.state = {
        changeLog: saved.changeLog,
        cpi: saved.cpi,
        escalations: saved.escalations,
        ledger: saved.ledger,
        occupancySqm: saved.occupancySqm,
        reviews: saved.reviews,
        tenants: saved.tenants,
      };
      this.version = saved.version;
      this.ledgerId = saved.ledgerId;
    }
    this.snapshot = null;
    this.rolledBack += 1;
  }

  /** A JSON picture of every table, for "nothing changed" assertions. */
  picture(): string {
    return JSON.stringify(this.state);
  }

  review(reviewId: string): Row {
    const row = this.state.reviews.find((r) => r.ReviewId === reviewId);
    if (!row) throw new Error(`no review ${reviewId}`);
    return row;
  }

  tenant(tenantId: number): Row {
    const row = this.state.tenants.find((t) => t.TenantId === tenantId);
    if (!row) throw new Error(`no tenant ${tenantId}`);
    return row;
  }

  ledgerRows(): Array<Row & { after: Row | null; before: Row | null; computed: Row | null }> {
    const json = (value: unknown) => (typeof value === "string" ? (JSON.parse(value) as Row) : null);
    return this.state.ledger.map((row) => ({ ...row, after: json(row.After), before: json(row.Before), computed: json(row.Computed) }));
  }

  private resolvedDates(tenantId: number): string | null {
    const dates = this.state.reviews
      .filter(
        (r) =>
          r.TenantId === tenantId &&
          ((r.State !== null && r.State !== undefined && ["approved", "completed", "waived"].includes(String(r.State))) ||
            ((r.State === null || r.State === undefined) && ["completed", "skipped", "waived"].includes(String(r.Status)))),
      )
      .map((r) => asIso(r.ScheduledFor));
    return dates.length ? dates.join(",") : null;
  }

  /** The review queries' LAST_RETURN: the latest rent_review.return with no submit after it, in progress only. */
  private lastReturn(review: Row): Row {
    if (review.State !== "in_progress") return {};
    const rows = this.state.ledger.filter((l) => l.SubjectType === "rent_review" && l.SubjectId === review.ReviewId);
    const ret = rows.filter((l) => l.Action === "rent_review.return").sort((a, b) => Number(b.LedgerId) - Number(a.LedgerId))[0];
    if (!ret || rows.some((l) => l.Action === "rent_review.submit" && Number(l.LedgerId) > Number(ret.LedgerId))) return {};
    return { ReturnNote: ret.Reason, ReturnedAt: new Date(String(ret.OccurredAt)), ReturnedByName: ret.ActorName };
  }

  private joined(review: Row): Row {
    const tenant = this.tenant(Number(review.TenantId));
    return {
      ...review,
      ...this.lastReturn(review),
      LegalName: tenant.LegalName,
      OwnerName: review.OwnerUserId ? `User ${review.OwnerUserId}` : null,
      TenantArchivedAt: tenant.ArchivedAt ?? null,
      TenantBuildingId: tenant.BuildingId,
      TenantStatus: tenant.Status,
      TradingName: tenant.TradingName ?? null,
      Version: Buffer.from(String(review.Version), "hex"),
    };
  }

  private tenantView(tenant: Row): Row {
    return { ...tenant, BuildingName: "Tower A", ResolvedReviewDates: this.resolvedDates(Number(tenant.TenantId)) };
  }

  private checkOpenIndex(): void {
    const open = new Map<number, number>();
    for (const r of this.state.reviews) {
      if (!OPEN.includes(String(r.State))) continue;
      const n = (open.get(Number(r.TenantId)) ?? 0) + 1;
      if (n > 1) throw Object.assign(new Error("Cannot insert duplicate key row in object 'dbo.RentReviews' with unique index 'UX_RentReviews_OpenPerTenant'"), { number: 2601 });
      open.set(Number(r.TenantId), n);
    }
  }

  /** Applies "Col = @P, Col = NULL, Col = SYSUTCDATETIME(), Col = 'x', Col = Col + 1" to a row. */
  private applySet(row: Row, setClause: string, params: Record<string, unknown>): void {
    for (const raw of setClause.split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const match = part.match(/^\[?(\w+)\]?\s*=\s*([\s\S]+)$/);
      if (!match) throw new Error(`can't read SET part: ${part}`);
      const [, column, expr] = match;
      const value = expr.trim();
      if (value.startsWith("@")) row[column] = params[value.slice(1)];
      else if (/^NULL$/i.test(value)) row[column] = null;
      else if (/^SYSUTCDATETIME\(\)$/i.test(value)) row[column] = new Date();
      else if (/^'.*'$/.test(value)) row[column] = value.slice(1, -1);
      else if (new RegExp(`^${column}\\s*\\+\\s*1$`).test(value)) row[column] = Number(row[column] ?? 0) + 1;
      else throw new Error(`can't evaluate ${value}`);
    }
  }

  async execute(sql: string, list: Param[] = []): Promise<Row[]> {
    this.log.push(sql);
    const injected = this.failSql?.(sql) ?? null;
    if (injected) throw injected;
    const p = Object.fromEntries(list.map((x) => [x.name, x.value]));

    if (/INSERT INTO dbo\.DecisionLedger/.test(sql)) {
      const row = { ...p, LedgerId: this.ledgerId++, OccurredAt: new Date().toISOString() };
      if (this.failLedger?.(row)) throw new Error("ledger unavailable (injected)");
      this.state.ledger.push(row);
      return [];
    }
    if (/^SELECT TOP 1 \[Before\], \[After\]\s+FROM dbo\.DecisionLedger/.test(sql.trim())) {
      const found = this.state.ledger
        .filter((r) => r.SubjectType === "rent_review" && r.SubjectId === p.ReviewId && r.Action === "rent_review.apply")
        .sort((a, b) => Number(b.LedgerId) - Number(a.LedgerId))[0];
      return found ? [{ After: found.After, Before: found.Before }] : [];
    }
    if (/^SELECT DISTINCT l\.ActorUserId\s+FROM dbo\.DecisionLedger l/.test(sql.trim())) {
      const rows = this.state.ledger.filter((r) => r.SubjectType === "rent_review" && r.SubjectId === p.ReviewId);
      const commenced = Math.max(0, ...rows.filter((r) => r.Action === "rent_review.commence").map((r) => Number(r.LedgerId)));
      const ids = rows
        .filter((r) => r.Action === "rent_review.basis_update" && Number(r.LedgerId) > commenced && r.ActorUserId !== null && r.ActorUserId !== undefined)
        .map((r) => Number(r.ActorUserId));
      return [...new Set(ids)].map((id) => ({ ActorUserId: id }));
    }
    if (/^SELECT TOP 1 Action, OccurredAt, ActorName, Reason\s+FROM dbo\.DecisionLedger/.test(sql.trim())) {
      const found = this.state.ledger
        .filter((r) => r.SubjectType === "tenancy" && r.SubjectId === p.TenantId && String(r.Action).startsWith("schedule.sign_off"))
        .sort((a, b) => Number(b.LedgerId) - Number(a.LedgerId))[0];
      return found ? [{ Action: found.Action, ActorName: found.ActorName, OccurredAt: new Date(String(found.OccurredAt)), Reason: found.Reason ?? null }] : [];
    }
    if (/INSERT INTO dbo\.RentScheduleChangeLog/.test(sql)) {
      this.state.changeLog.push({ ...p });
      return [];
    }
    if (/FROM dbo\.RentScheduleChangeLog/.test(sql)) {
      const ids = Object.entries(p).filter(([k]) => k.startsWith("Change")).map(([, v]) => v);
      return this.state.changeLog.filter((r) => r.TenantId === p.TenantId && ids.includes(r.ChangeId));
    }
    if (/^SELECT e\.TargetRole, e\.NoIndependentTarget, e\.\[Level\], e\.Status\s+FROM dbo\.Escalations e/.test(sql.trim())) {
      const review = this.state.reviews.find((r) => r.ReviewId === p.ReviewId);
      const since = review?.SubmittedAt instanceof Date ? review.SubmittedAt.getTime() : null;
      return this.state.escalations.filter(
        (e) =>
          e.SubjectId === p.ReviewId &&
          e.PolicyKey === p.Approval &&
          (since === null || !(e.CreatedAt instanceof Date) || e.CreatedAt.getTime() >= since),
      );
    }
    if (/FROM dbo\.Escalations/.test(sql)) return [];
    if (/FROM dbo\.CpiIndex/.test(sql)) {
      return this.state.cpi.filter((r) => r.Region === p.Region && (r.Period === p.PeriodA || r.Period === p.PeriodB));
    }
    if (/FROM dbo\.TenantOccupancies/.test(sql)) return [{ Sqm: this.state.occupancySqm[Number(p.TenantId)] ?? 0 }];

    // Reviews
    if (/^SELECT TOP \(@Limit\)[\s\S]*FROM dbo\.RentReviews r/.test(sql.trim())) {
      return this.state.reviews
        .filter((r) => r.State !== null && r.State !== undefined && (p.TenantId === undefined || r.TenantId === p.TenantId))
        .map((r) => this.joined(r));
    }
    if (/FROM dbo\.RentReviews r[\s\S]*WHERE r\.ReviewId = @ReviewId/.test(sql)) {
      const row = this.state.reviews.find((r) => r.ReviewId === p.ReviewId && r.State !== null && r.State !== undefined);
      return row ? [this.joined(row)] : [];
    }
    if (/SELECT TOP 1 ReviewId FROM dbo\.RentReviews/.test(sql)) {
      const row = this.state.reviews.find((r) => r.TenantId === p.TenantId && r.ReviewId !== p.ReviewId && OPEN.includes(String(r.State)));
      return row ? [{ ReviewId: row.ReviewId }] : [];
    }
    if (/FROM dbo\.RentReviews\s+WHERE TenantId = @TenantId AND State IN/.test(sql)) {
      return this.state.reviews.filter((r) => r.TenantId === p.TenantId && OPEN.includes(String(r.State))).map((r) => ({ ...r }));
    }
    if (/INSERT INTO dbo\.RentReviews/.test(sql)) {
      const columns = (sql.match(/\(([^)]*)\)\s*VALUES/) as RegExpMatchArray)[1].split(",").map((c) => c.trim());
      const values = (sql.match(/VALUES\s*\(([\s\S]*)\)\s*$/) as RegExpMatchArray)[1].split(",").map((v) => v.trim());
      const row: Row = { CreatedAt: new Date(), Version: this.nextVersion() };
      columns.forEach((column, i) => this.applySet(row, `${column} = ${values[i]}`, p));
      this.state.reviews.push(row);
      this.checkOpenIndex();
      return [];
    }
    if (/UPDATE dbo\.RentReviews/.test(sql)) {
      const setClause = (sql.match(/SET([\s\S]*?)(?:OUTPUT|WHERE)/) as RegExpMatchArray)[1];
      const where = (sql.match(/WHERE([\s\S]*)$/) as RegExpMatchArray)[1];
      const states = where.includes("State IN")
        ? (where.match(/State IN \(([^)]*)\)/) as RegExpMatchArray)[1].split(",").map((s) => s.trim()).map((s) => (s.startsWith("@") ? String(p[s.slice(1)]) : s.replace(/'/g, "")))
        : [(where.match(/State = '(\w+)'/) as RegExpMatchArray)[1]];
      const row = this.state.reviews.find((r) => r.ReviewId === p.ReviewId && states.includes(String(r.State)));
      if (!row) return [];
      this.applySet(row, setClause, p);
      row.Version = this.nextVersion();
      this.checkOpenIndex();
      return [{ ReviewId: row.ReviewId }];
    }

    // Tenants
    if (/^SELECT\s+\(\s*SELECT STRING_AGG[\s\S]*AS ResolvedReviewDates\s+FROM dbo\.Tenants t\s+WHERE t\.TenantId = @TenantId$/.test(sql.trim())) {
      return [{ ResolvedReviewDates: this.resolvedDates(Number(p.TenantId)) }];
    }
    if (/FROM dbo\.Tenants t( WITH \(UPDLOCK, ROWLOCK\))?\s+(LEFT JOIN dbo\.Buildings b ON b\.BuildingID = t\.BuildingId\s+)?WHERE t\.TenantId = @TenantId/.test(sql)) {
      const tenant = this.state.tenants.find((t) => t.TenantId === p.TenantId);
      if (!tenant) return [];
      if (/t\.Status <> 'vacated' AND t\.ArchivedAt IS NULL/.test(sql) && (tenant.Status === "vacated" || tenant.ArchivedAt)) return [];
      return [this.tenantView(tenant)];
    }
    if (/UPDATE dbo\.Tenants SET/.test(sql)) {
      const setClause = (sql.match(/SET([\s\S]*?)OUTPUT/) as RegExpMatchArray)[1];
      const tenant = this.tenant(Number(p.TenantId));
      this.applySet(tenant, setClause, p);
      return [{ ScheduleVersion: tenant.ScheduleVersion }];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

/** Wires a world into the mocked ../db module. */
export function useWorld(world: () => ReviewWorld, db: Record<string, jest.Mock>): void {
  db.executeQuery.mockImplementation((_c: unknown, sql: string, params?: Param[]) => world().execute(sql, params));
  db.beginTransaction.mockImplementation(async () => world().begin());
  db.commitTransaction.mockImplementation(async () => world().commit());
  db.rollbackTransaction.mockImplementation(async () => world().rollback());
  db.createRequestConnection.mockResolvedValue({});
  db.closeConnection.mockImplementation(() => undefined);
}
