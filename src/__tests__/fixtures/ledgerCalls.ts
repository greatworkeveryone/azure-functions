// Reads the decision-ledger rows a test's mocked executeQuery was asked to
// INSERT, so a handler test can assert on what record() really sent (the same
// approach users.test.ts and approval-limits-ledger.test.ts take) instead of
// on a mock of record().

interface MockedFn {
  mock: { calls: unknown[][]; invocationCallOrder: number[] };
}

export interface LedgerInsert {
  action: string;
  actorKind: unknown;
  actorName: unknown;
  actorRole: unknown;
  actorUserId: unknown;
  after: unknown;
  attributedName: unknown;
  attributedRole: unknown;
  attributedUserId: unknown;
  before: unknown;
  buildingId: unknown;
  correlationId: unknown;
  isException: unknown;
  jobId: unknown;
  /** Position among every call the test's mocks saw, to compare with begin/commit/MYOB. */
  order: number;
  reason: unknown;
  ruleApplied: unknown;
  subjectId: unknown;
  subjectType: unknown;
}

type Param = { name: string; value: unknown };

const json = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : null);

export function ledgerInserts(executeQuery: MockedFn): LedgerInsert[] {
  return executeQuery.mock.calls.flatMap((call, i) => {
    if (typeof call[1] !== "string" || !call[1].includes("INSERT INTO dbo.DecisionLedger")) return [];
    const p = Object.fromEntries(((call[2] as Param[] | undefined) ?? []).map((x) => [x.name, x.value]));
    return [
      {
        action: p.Action as string,
        actorKind: p.ActorKind,
        actorName: p.ActorName,
        actorRole: p.ActorRole,
        actorUserId: p.ActorUserId,
        after: json(p.After),
        attributedName: p.AttributedName,
        attributedRole: p.AttributedRole,
        attributedUserId: p.AttributedUserId,
        before: json(p.Before),
        buildingId: p.BuildingId,
        correlationId: p.CorrelationId,
        isException: p.IsException,
        jobId: p.JobId,
        order: executeQuery.mock.invocationCallOrder[i],
        reason: p.Reason,
        ruleApplied: p.RuleApplied,
        subjectId: p.SubjectId,
        subjectType: p.SubjectType,
      },
    ];
  });
}
