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

    it("(Tenant, *) + TENANT_UNBLOCKED → (Work, facilities)", () => {
      expect(
        nextState(
          { status: JobStatus.TENANT, awaitingRole: AwaitingRole.FACILITIES },
          JobEvent.TENANT_UNBLOCKED,
        ),
      ).toEqual({ status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES });
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
  });
});
