import {
  JobStatus,
  JobEvent,
  AwaitingRole,
  nextState,
  canTransition,
  allowedNextStatuses,
  resolveManualTarget,
} from "../jobStatusMachine";

describe("jobStatusMachine — composite (status, awaitingRole)", () => {
  describe("nextState — happy paths", () => {
    it("(New, facilities) + QUOTE_REQUESTED → (Quote, facilities)", () => {
      expect(
        nextState(
          { status: JobStatus.NEW, awaitingRole: AwaitingRole.FACILITIES },
          JobEvent.QUOTE_REQUESTED,
        ),
      ).toEqual({ status: JobStatus.QUOTE, awaitingRole: AwaitingRole.FACILITIES });
    });

    it("(Quote, facilities) + QUOTE_RECEIVED → (Awaiting Approval, facilities)", () => {
      expect(
        nextState(
          { status: JobStatus.QUOTE, awaitingRole: AwaitingRole.FACILITIES },
          JobEvent.QUOTE_RECEIVED,
        ),
      ).toEqual({
        status: JobStatus.AWAITING_APPROVAL,
        awaitingRole: AwaitingRole.FACILITIES,
      });
    });

    it("(Awaiting Approval, facilities) + QUOTE_APPROVED → (Work, facilities)", () => {
      expect(
        nextState(
          {
            status: JobStatus.AWAITING_APPROVAL,
            awaitingRole: AwaitingRole.FACILITIES,
          },
          JobEvent.QUOTE_APPROVED,
        ),
      ).toEqual({ status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES });
    });

    it("(Awaiting Approval, facilities) + PO_CREATED → (Work, facilities)", () => {
      expect(
        nextState(
          {
            status: JobStatus.AWAITING_APPROVAL,
            awaitingRole: AwaitingRole.FACILITIES,
          },
          JobEvent.PO_CREATED,
        ),
      ).toEqual({ status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES });
    });

    it("(Work, facilities) + WORK_COMPLETED → (Awaiting Approval, accounts) — the disambiguation", () => {
      expect(
        nextState(
          { status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES },
          JobEvent.WORK_COMPLETED,
        ),
      ).toEqual({
        status: JobStatus.AWAITING_APPROVAL,
        awaitingRole: AwaitingRole.ACCOUNTS,
      });
    });

    it("(Awaiting Approval, accounts) + INVOICE_APPROVED → (Done, accounts)", () => {
      expect(
        nextState(
          {
            status: JobStatus.AWAITING_APPROVAL,
            awaitingRole: AwaitingRole.ACCOUNTS,
          },
          JobEvent.INVOICE_APPROVED,
        ),
      ).toEqual({ status: JobStatus.DONE, awaitingRole: AwaitingRole.ACCOUNTS });
    });

    it("Tenant block reachable from non-Done states; awaitingRole preserved", () => {
      expect(
        nextState(
          { status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES },
          JobEvent.TENANT_BLOCKED,
        ),
      ).toEqual({ status: JobStatus.TENANT, awaitingRole: AwaitingRole.FACILITIES });
    });

    it("(Tenant, *) + TENANT_UNBLOCKED → (Work, facilities) when no pre-block state captured (legacy)", () => {
      expect(
        nextState(
          { status: JobStatus.TENANT, awaitingRole: AwaitingRole.FACILITIES },
          JobEvent.TENANT_UNBLOCKED,
        ),
      ).toEqual({ status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES });
    });

    it("TENANT_UNBLOCKED restores the captured pre-block state exactly (Awaiting Approval / facilities — quote NOT yet approved)", () => {
      // The bug: a job blocked at (Awaiting Approval, facilities) used to land
      // in (Work, facilities) on unblock, skipping QUOTE_APPROVED. With the
      // pre-block state captured, it must return to where it was.
      expect(
        nextState(
          { status: JobStatus.TENANT, awaitingRole: AwaitingRole.FACILITIES },
          JobEvent.TENANT_UNBLOCKED,
          {
            preBlockState: {
              status: JobStatus.AWAITING_APPROVAL,
              awaitingRole: AwaitingRole.FACILITIES,
            },
          },
        ),
      ).toEqual({
        status: JobStatus.AWAITING_APPROVAL,
        awaitingRole: AwaitingRole.FACILITIES,
      });
    });

    it("TENANT_UNBLOCKED restores a captured accounts-side approval state", () => {
      expect(
        nextState(
          { status: JobStatus.TENANT, awaitingRole: AwaitingRole.ACCOUNTS },
          JobEvent.TENANT_UNBLOCKED,
          {
            preBlockState: {
              status: JobStatus.AWAITING_APPROVAL,
              awaitingRole: AwaitingRole.ACCOUNTS,
            },
          },
        ),
      ).toEqual({
        status: JobStatus.AWAITING_APPROVAL,
        awaitingRole: AwaitingRole.ACCOUNTS,
      });
    });

    it("TENANT_UNBLOCKED ignores a (Tenant, *) or (Done, *) pre-block state and falls back to (Work, facilities)", () => {
      // Defensive: a captured pre-block state that is itself Tenant/Done is
      // nonsensical (you can't block from Done, and a doubly-blocked Tenant
      // can't be the restore target). Fall back to the legacy safe state.
      expect(
        nextState(
          { status: JobStatus.TENANT, awaitingRole: AwaitingRole.FACILITIES },
          JobEvent.TENANT_UNBLOCKED,
          {
            preBlockState: {
              status: JobStatus.DONE,
              awaitingRole: AwaitingRole.ACCOUNTS,
            },
          },
        ),
      ).toEqual({ status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES });
    });

    it("pre-block state is ignored for non-unblock events", () => {
      expect(
        nextState(
          { status: JobStatus.NEW, awaitingRole: AwaitingRole.FACILITIES },
          JobEvent.QUOTE_REQUESTED,
          {
            preBlockState: {
              status: JobStatus.AWAITING_APPROVAL,
              awaitingRole: AwaitingRole.FACILITIES,
            },
          },
        ),
      ).toEqual({ status: JobStatus.QUOTE, awaitingRole: AwaitingRole.FACILITIES });
    });
  });

  describe("nextState — invariants", () => {
    it("returns null for illegal transitions (no demotion, no skip)", () => {
      expect(
        nextState(
          { status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES },
          JobEvent.QUOTE_RECEIVED,
        ),
      ).toBeNull();
      expect(
        nextState(
          { status: JobStatus.DONE, awaitingRole: AwaitingRole.ACCOUNTS },
          JobEvent.WORK_COMPLETED,
        ),
      ).toBeNull();
    });

    it("INVOICE_APPROVED on (Awaiting Approval, facilities) is illegal (wrong approval step)", () => {
      expect(
        nextState(
          {
            status: JobStatus.AWAITING_APPROVAL,
            awaitingRole: AwaitingRole.FACILITIES,
          },
          JobEvent.INVOICE_APPROVED,
        ),
      ).toBeNull();
    });

    it("QUOTE_APPROVED on (Awaiting Approval, accounts) is illegal (wrong approval step)", () => {
      expect(
        nextState(
          {
            status: JobStatus.AWAITING_APPROVAL,
            awaitingRole: AwaitingRole.ACCOUNTS,
          },
          JobEvent.QUOTE_APPROVED,
        ),
      ).toBeNull();
    });

    it("Done is terminal for all non-tenant events", () => {
      const done = { status: JobStatus.DONE, awaitingRole: AwaitingRole.ACCOUNTS };
      const nonTerminalEvents = [
        JobEvent.QUOTE_REQUESTED,
        JobEvent.QUOTE_RECEIVED,
        JobEvent.QUOTE_APPROVED,
        JobEvent.PO_CREATED,
        JobEvent.WORK_COMPLETED,
        JobEvent.INVOICE_APPROVED,
        JobEvent.TENANT_BLOCKED,
      ];
      for (const ev of nonTerminalEvents) {
        expect(nextState(done, ev)).toBeNull();
      }
    });
  });

  describe("canTransition (used by picker / addJobEvent validation)", () => {
    it("allows (Awaiting Approval, facilities) → Work — the forward edge", () => {
      expect(
        canTransition(
          { status: JobStatus.AWAITING_APPROVAL, awaitingRole: AwaitingRole.FACILITIES },
          JobStatus.WORK,
        ),
      ).toBe(true);
    });

    it("allows (Awaiting Approval, accounts) → Done — the forward edge", () => {
      expect(
        canTransition(
          { status: JobStatus.AWAITING_APPROVAL, awaitingRole: AwaitingRole.ACCOUNTS },
          JobStatus.DONE,
        ),
      ).toBe(true);
    });

    it("rejects (Awaiting Approval, facilities) → Done (wrong approval step)", () => {
      expect(
        canTransition(
          { status: JobStatus.AWAITING_APPROVAL, awaitingRole: AwaitingRole.FACILITIES },
          JobStatus.DONE,
        ),
      ).toBe(false);
    });

    it("rejects New → Done", () => {
      expect(
        canTransition(
          { status: JobStatus.NEW, awaitingRole: AwaitingRole.FACILITIES },
          JobStatus.DONE,
        ),
      ).toBe(false);
    });

    it("allows any non-Done → Tenant (stall escape hatch)", () => {
      expect(
        canTransition(
          { status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES },
          JobStatus.TENANT,
        ),
      ).toBe(true);
    });

    it("allows Tenant → Work (return from stall)", () => {
      expect(
        canTransition(
          { status: JobStatus.TENANT, awaitingRole: AwaitingRole.FACILITIES },
          JobStatus.WORK,
        ),
      ).toBe(true);
    });
  });

  describe("allowedNextStatuses (picker filter)", () => {
    it("from (Awaiting Approval, facilities) → [Work, Tenant]", () => {
      const allowed = allowedNextStatuses({
        status: JobStatus.AWAITING_APPROVAL,
        awaitingRole: AwaitingRole.FACILITIES,
      });
      expect(allowed).toEqual(expect.arrayContaining([JobStatus.WORK, JobStatus.TENANT]));
      expect(allowed).not.toContain(JobStatus.DONE);
    });

    it("from (Awaiting Approval, accounts) → [Done, Tenant]", () => {
      const allowed = allowedNextStatuses({
        status: JobStatus.AWAITING_APPROVAL,
        awaitingRole: AwaitingRole.ACCOUNTS,
      });
      expect(allowed).toEqual(expect.arrayContaining([JobStatus.DONE, JobStatus.TENANT]));
      expect(allowed).not.toContain(JobStatus.WORK);
    });

    it("from Done → empty (terminal)", () => {
      expect(
        allowedNextStatuses({
          status: JobStatus.DONE,
          awaitingRole: AwaitingRole.ACCOUNTS,
        }),
      ).toEqual([]);
    });

    it("from Tenant → [Work]", () => {
      expect(
        allowedNextStatuses({
          status: JobStatus.TENANT,
          awaitingRole: AwaitingRole.FACILITIES,
        }),
      ).toEqual([JobStatus.WORK]);
    });
  });

  describe("resolveManualTarget (picker submit / addJobEvent)", () => {
    it("from (Work, facilities) picking Awaiting Approval flips role to accounts", () => {
      expect(
        resolveManualTarget(
          { status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES },
          JobStatus.AWAITING_APPROVAL,
        ),
      ).toEqual({
        status: JobStatus.AWAITING_APPROVAL,
        awaitingRole: AwaitingRole.ACCOUNTS,
      });
    });

    it("from (Quote, facilities) picking Awaiting Approval keeps role facilities", () => {
      expect(
        resolveManualTarget(
          { status: JobStatus.QUOTE, awaitingRole: AwaitingRole.FACILITIES },
          JobStatus.AWAITING_APPROVAL,
        ),
      ).toEqual({
        status: JobStatus.AWAITING_APPROVAL,
        awaitingRole: AwaitingRole.FACILITIES,
      });
    });

    it("returns null for an illegal pick", () => {
      expect(
        resolveManualTarget(
          { status: JobStatus.NEW, awaitingRole: AwaitingRole.FACILITIES },
          JobStatus.DONE,
        ),
      ).toBeNull();
    });

    it("Tenant target preserves the current awaitingRole (so we know which queue to return to)", () => {
      expect(
        resolveManualTarget(
          { status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES },
          JobStatus.TENANT,
        ),
      ).toEqual({
        status: JobStatus.TENANT,
        awaitingRole: AwaitingRole.FACILITIES,
      });
    });

    it("Tenant → Work without captured pre-block state lands on (Work, facilities) (legacy)", () => {
      expect(
        resolveManualTarget(
          { status: JobStatus.TENANT, awaitingRole: AwaitingRole.FACILITIES },
          JobStatus.WORK,
        ),
      ).toEqual({
        status: JobStatus.WORK,
        awaitingRole: AwaitingRole.FACILITIES,
      });
    });

    it("Tenant → Work restores the captured pre-block (Awaiting Approval, facilities) — the unblock-bypass fix", () => {
      expect(
        resolveManualTarget(
          { status: JobStatus.TENANT, awaitingRole: AwaitingRole.FACILITIES },
          JobStatus.WORK,
          {
            preBlockState: {
              status: JobStatus.AWAITING_APPROVAL,
              awaitingRole: AwaitingRole.FACILITIES,
            },
          },
        ),
      ).toEqual({
        status: JobStatus.AWAITING_APPROVAL,
        awaitingRole: AwaitingRole.FACILITIES,
      });
    });
  });

  // ── WP10: standing-contract fast path ──────────────────────────────────────
  // Contract jobs may start work directly from New (WORK_AUTHORIZED), skipping
  // the quote round. The opt is threaded through nextState / canTransition /
  // allowedNextStatuses / resolveManualTarget. Non-contract jobs are
  // behaviour-identical — every test in the blocks above passes UNMODIFIED.
  describe("WP10 — standing-contract WORK_AUTHORIZED (New → Work, no quote)", () => {
    const NEW_FAC = { status: JobStatus.NEW, awaitingRole: AwaitingRole.FACILITIES };
    const WORK_FAC = { status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES };

    it("nextState: (New, facilities) + WORK_AUTHORIZED → (Work, facilities) for a contract job", () => {
      expect(nextState(NEW_FAC, JobEvent.WORK_AUTHORIZED, { isContract: true })).toEqual(WORK_FAC);
    });

    it("nextState: WORK_AUTHORIZED is illegal for a non-contract job (no opts)", () => {
      expect(nextState(NEW_FAC, JobEvent.WORK_AUTHORIZED)).toBeNull();
      expect(nextState(NEW_FAC, JobEvent.WORK_AUTHORIZED, { isContract: false })).toBeNull();
    });

    it("nextState: WORK_AUTHORIZED is illegal from any state other than (New, facilities), even for a contract", () => {
      expect(
        nextState(
          { status: JobStatus.QUOTE, awaitingRole: AwaitingRole.FACILITIES },
          JobEvent.WORK_AUTHORIZED,
          { isContract: true },
        ),
      ).toBeNull();
      expect(
        nextState(
          { status: JobStatus.NEW, awaitingRole: AwaitingRole.ACCOUNTS },
          JobEvent.WORK_AUTHORIZED,
          { isContract: true },
        ),
      ).toBeNull();
    });

    it("canTransition: contract job allows New → Work; non-contract does not", () => {
      expect(canTransition(NEW_FAC, JobStatus.WORK, { isContract: true })).toBe(true);
      expect(canTransition(NEW_FAC, JobStatus.WORK)).toBe(false);
      expect(canTransition(NEW_FAC, JobStatus.WORK, { isContract: false })).toBe(false);
    });

    it("canTransition: a contract job still cannot skip straight to Done from New", () => {
      expect(canTransition(NEW_FAC, JobStatus.DONE, { isContract: true })).toBe(false);
    });

    it("allowedNextStatuses: contract from (New, facilities) includes Work; non-contract does not", () => {
      expect(allowedNextStatuses(NEW_FAC, { isContract: true })).toEqual(
        expect.arrayContaining([JobStatus.WORK, JobStatus.TENANT]),
      );
      expect(allowedNextStatuses(NEW_FAC)).not.toContain(JobStatus.WORK);
    });

    it("resolveManualTarget: contract New → Work resolves to (Work, facilities)", () => {
      expect(resolveManualTarget(NEW_FAC, JobStatus.WORK, { isContract: true })).toEqual(WORK_FAC);
    });

    it("resolveManualTarget: non-contract New → Work is null (illegal)", () => {
      expect(resolveManualTarget(NEW_FAC, JobStatus.WORK)).toBeNull();
    });

    it("downstream financial states are unchanged for a contract job (Work → Awaiting Approval/accounts → Done)", () => {
      // The contract flag only opens the New → Work door. Once in Work the job
      // is byte-identical to a quoted job: complete → invoice approval → done.
      expect(nextState(WORK_FAC, JobEvent.WORK_COMPLETED, { isContract: true })).toEqual({
        status: JobStatus.AWAITING_APPROVAL,
        awaitingRole: AwaitingRole.ACCOUNTS,
      });
      expect(
        nextState(
          { status: JobStatus.AWAITING_APPROVAL, awaitingRole: AwaitingRole.ACCOUNTS },
          JobEvent.INVOICE_APPROVED,
          { isContract: true },
        ),
      ).toEqual({ status: JobStatus.DONE, awaitingRole: AwaitingRole.ACCOUNTS });
    });
  });
});
