-- Migration 138: dbo.JobDecisions and the job.next_step escalation policy
-- (jobs plan slice A2, "Respond"; decisions D1 and D5).
--
-- A decision request (migration 137) is answered by exactly one of its listed
-- decision-makers with an outcome, a required rationale and, unless the outcome is
-- to defer, a next step owned by a person or a role. That answer is one row here.
-- It closes the question and hands the job on; the chasing of what comes next is
-- the escalation engine's (the job.next_step policy seeded below).
--
--   RequestId           the request this answers. UNIQUE: a request is answered
--                       once; asking again (a deferral coming round, a revision
--                       resubmitted) is a new request and a new row.
--   Outcome             approve | deny | defer | revise.
--   Rationale           why. Required, never blank. The API takes at most 2000
--                       characters (the ledger's limit for a reason); the column
--                       has room beyond that.
--   NextStep            what happens now, in words. Required for approve, deny and
--                       revise; optional for defer. Its owner is a person
--                       (NextStepOwnerUserId) or a role (NextStepOwnerRole), never
--                       both, and it has a due moment (NextStepDueAt, UTC) set from
--                       the request's tier. A step has all three or none.
--   DeferUntil          defer only: the business day (Darwin) the question comes
--                       back. The sweep asks again that morning (ReaskRequestId).
--   ReaskRequestId      the request raised when a deferral came due. UNIQUE, so a
--                       deferral is asked again exactly once however many sweeps
--                       run, and set in the same transaction as that request.
--   NextStepClosed*     how the next step ended, once it has: 'done' by the owner
--                       or a manager (with an optional note), or 'replaced' when a
--                       later decision on the same job took over. NULL while the
--                       step is open. This is the only part of the row that is
--                       ever written after it is inserted, and only once.
--   RowVersion          a stale write is a 409.
--
-- Rows are never deleted. Every response and every step done is also a row in
-- dbo.DecisionLedger (decision.approve, .deny, .defer, .revise, .next_step_done).
--
-- The policy: job.next_step is an ATTENTION escalation on the job, raised for the
-- next step's owner when the decision is made. The ladder is the owner, then the
-- owner's manager for 16 business hours (the engine takes the manager from the
-- owner's role), then a director. When it first moves up comes from the request's
-- tier, not from a number in the policy. It ends when the step is marked done
-- (completeJobNextStep), or by the sweep when the step is no longer open (the job
-- was archived or closed). It cannot be acknowledged, resolved or withdrawn from
-- the inbox: the step is done, not claimed.
--
-- Additive and re-runnable: the table and each index sit behind an existence check
-- and nothing existing is touched. The policy is seeded with MERGE ... WHEN NOT
-- MATCHED THEN INSERT only, so running this again never overwrites a policy an
-- admin has edited (a switch flipped included). Number 138 is reserved for A2;
-- never renumber.
--
-- RUNBOOK: apply 138 (after 137) before the build that serves respondToJobDecision.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

-- 137 makes the table this one answers. Say so plainly rather than fail on a foreign key.
IF OBJECT_ID('dbo.JobDecisionRequests', 'U') IS NULL
BEGIN
  ;THROW 51138, N'Apply migration 137 first: dbo.JobDecisionRequests does not exist.', 1;
END
GO

IF OBJECT_ID('dbo.JobDecisions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.JobDecisions (
    DecisionId            INT            IDENTITY(1,1) NOT NULL,
    RequestId             INT            NOT NULL,
    JobId                 INT            NOT NULL,
    Outcome               NVARCHAR(10)   NOT NULL,
    Rationale             NVARCHAR(4000) NOT NULL,
    NextStep              NVARCHAR(2000) NULL,
    NextStepOwnerUserId   INT            NULL,
    NextStepOwnerRole     NVARCHAR(32)   NULL,
    NextStepDueAt         DATETIME2(3)   NULL,
    DeferUntil            DATE           NULL,
    ReaskRequestId        INT            NULL,
    RespondedById         INT            NULL,
    RespondedByName       NVARCHAR(200)  NOT NULL,
    RespondedAt           DATETIME2(3)   NOT NULL CONSTRAINT DF_JobDecisions_RespondedAt DEFAULT SYSUTCDATETIME(),
    NextStepClosedAt      DATETIME2(3)   NULL,
    NextStepClosedKind    NVARCHAR(10)   NULL,
    NextStepClosedById    INT            NULL,
    NextStepClosedByName  NVARCHAR(200)  NULL,
    NextStepClosedNote    NVARCHAR(1000) NULL,
    RowVersion            ROWVERSION     NOT NULL,
    CONSTRAINT PK_JobDecisions PRIMARY KEY CLUSTERED (DecisionId),
    CONSTRAINT FK_JobDecisions_Requests FOREIGN KEY (RequestId)
      REFERENCES dbo.JobDecisionRequests(RequestId),
    CONSTRAINT FK_JobDecisions_Jobs FOREIGN KEY (JobId)
      REFERENCES dbo.Jobs(JobID),
    CONSTRAINT FK_JobDecisions_Reask FOREIGN KEY (ReaskRequestId)
      REFERENCES dbo.JobDecisionRequests(RequestId),
    CONSTRAINT CK_JobDecisions_Outcome CHECK (Outcome IN (N'approve', N'deny', N'defer', N'revise')),
    CONSTRAINT CK_JobDecisions_Rationale CHECK (LEN(LTRIM(RTRIM(Rationale))) > 0),
    CONSTRAINT CK_JobDecisions_NextStep CHECK (
      (NextStep IS NULL AND NextStepOwnerUserId IS NULL AND NextStepOwnerRole IS NULL AND NextStepDueAt IS NULL)
      OR (
        NextStep IS NOT NULL AND LEN(LTRIM(RTRIM(NextStep))) > 0 AND NextStepDueAt IS NOT NULL
        AND (
          (NextStepOwnerUserId IS NOT NULL AND NextStepOwnerRole IS NULL)
          OR (NextStepOwnerUserId IS NULL AND NextStepOwnerRole IS NOT NULL)
        )
      )
    ),
    CONSTRAINT CK_JobDecisions_NextStepNeeded CHECK (Outcome = N'defer' OR NextStep IS NOT NULL),
    CONSTRAINT CK_JobDecisions_Defer CHECK (
      (Outcome = N'defer' AND DeferUntil IS NOT NULL)
      OR (Outcome <> N'defer' AND DeferUntil IS NULL)
    ),
    CONSTRAINT CK_JobDecisions_Reask CHECK (ReaskRequestId IS NULL OR Outcome = N'defer'),
    CONSTRAINT CK_JobDecisions_StepClosed CHECK (
      (NextStepClosedAt IS NULL AND NextStepClosedKind IS NULL AND NextStepClosedById IS NULL
        AND NextStepClosedByName IS NULL AND NextStepClosedNote IS NULL)
      OR (
        NextStep IS NOT NULL AND NextStepClosedAt IS NOT NULL
        AND NextStepClosedKind IS NOT NULL AND NextStepClosedKind IN (N'done', N'replaced')
        AND NextStepClosedByName IS NOT NULL
      )
    )
  );
END
GO

-- A request is answered once.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_JobDecisions_Request' AND object_id = OBJECT_ID('dbo.JobDecisions'))
  CREATE UNIQUE INDEX UX_JobDecisions_Request
    ON dbo.JobDecisions (RequestId);
GO

-- Everything decided on one job, newest first (the job modal, the history).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_JobDecisions_JobId' AND object_id = OBJECT_ID('dbo.JobDecisions'))
  CREATE INDEX IX_JobDecisions_JobId
    ON dbo.JobDecisions (JobId, DecisionId DESC)
    INCLUDE (Outcome, RespondedAt);
GO

-- A deferral is asked again once: no two decisions share a re-ask, and a request
-- is the re-ask of at most one deferral.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_JobDecisions_Reask' AND object_id = OBJECT_ID('dbo.JobDecisions'))
  CREATE UNIQUE INDEX UX_JobDecisions_Reask
    ON dbo.JobDecisions (ReaskRequestId)
    WHERE ReaskRequestId IS NOT NULL;
GO

-- The sweep's scan: deferrals still waiting for their day.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_JobDecisions_DeferDue' AND object_id = OBJECT_ID('dbo.JobDecisions'))
  CREATE INDEX IX_JobDecisions_DeferDue
    ON dbo.JobDecisions (DeferUntil, DecisionId)
    INCLUDE (JobId, RequestId)
    WHERE Outcome = N'defer' AND ReaskRequestId IS NULL;
GO

-- Seed. The last value is Active. Urgent is 0 here: the next step raises its
-- escalation as urgent itself when the request it follows was urgent.
;WITH Seed (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active) AS (
  SELECT * FROM (VALUES
    (N'job.next_step', N'attention', 0, N'business', N'yes',
      N'[{"userTarget":true},{"token":"raiser_manager","slaHours":16},{"role":"director"}]', 1)
  ) AS v (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active)
)
MERGE dbo.EscalationPolicies AS target
USING Seed AS source
  ON target.PolicyKey = source.PolicyKey
WHEN NOT MATCHED BY TARGET THEN
  INSERT (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy)
  VALUES (source.PolicyKey, source.Kind, source.Urgent, source.Clock, source.AutoReescalate, source.Ladder, source.Active, N'migration:138_job_decisions');
GO
