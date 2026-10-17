-- Migration 137: dbo.JobDecisionRequests and the job.decision_pending escalation
-- policy (jobs plan slice A1, "Ask"; decisions D1, D4 and D5).
--
-- An Admin / Accounts job (Jobs.Kind = 'admin') exists to get a question decided.
-- Asking it is one row here: the question, who is asked, how long they are given and,
-- when the decision is about a document, which file. The request is the record of
-- the ask; the chasing is the escalation engine's. Raising a request also raises a
-- live escalation on the job under the policy seeded below, so the people asked
-- are emailed and see it in their escalation inbox, and it is reminded and moved
-- up to the raiser's manager on the tier's schedule. Answering it is slice A2
-- (JobDecisions, migration 138, one row per response); nothing here creates that.
--
--   DecisionMakers   JSON object: {"userIds":[3,5],"role":null} for named people,
--                    {"userIds":[3,9],"role":"accounts_manager"} when everyone in a
--                    role was asked (userIds are the people it was sent to).
--   AssignmentMode   'named' or 'role' (D4): kept on every request so stall rates
--                    can be compared by mode later.
--   Tier             emergency | urgent | soon | routine | fixed (D5).
--   RespondBy        when an answer is due, UTC; NULL only for an emergency, which
--                    has no deadline and is never chased.
--   RoutineWeeks     2 to 8, for a routine request only.
--   AutoEscalate     whether the request moves up to the raiser's manager on its own
--                    when nobody has answered (D5). Always true for soon, routine and
--                    fixed; always false for an emergency, which is never chased; for
--                    urgent it is the raiser's tick, and it is OFF unless they ticked
--                    it. An urgent request that is not ticked still gets its reminder.
--                    There is no default: the app says which, every time.
--   SourceAttachmentId  the file the decision is about (an email attachment or an
--                    uploaded PDF), on the same job. The app refuses to delete a
--                    file a request points at; the foreign key is the backstop.
--   State            pending -> answered (A2) or withdrawn. One request per job is
--                    pending at a time (the filtered unique index), as the engine
--                    allows one live escalation per job and policy.
--   RowVersion       a stale write is a 409.
--
-- Rows are never deleted: a request ends as answered or withdrawn, and a withdrawal
-- keeps who, when and why. Every request and withdrawal is also a row in
-- dbo.DecisionLedger (decision.requested, decision.withdrawn).
--
-- The policy: job.decision_pending is an AUTHORITY escalation, so it cannot be
-- resolved from the inbox, only decided (A2) or withdrawn; it is not acknowledged;
-- and the sweep neither condition-checks it nor restarts its clock on a new email.
-- The ladder is the people named when it is raised (userTarget), then the raiser's
-- manager for 16 business hours, then a director. When it first moves up, and when
-- reminders go out, comes from the tier, not from a number in this row (the engine
-- takes the due moment from the request, and no due moment at all when AutoEscalate
-- is off); the 16 hours is only how long the manager has before a director is told.
--
-- Additive and re-runnable: the table and each index sit behind an existence check
-- and nothing existing is touched. The policy is seeded with MERGE ... WHEN NOT
-- MATCHED THEN INSERT only, so running this again never overwrites a policy an
-- admin has edited (a switch flipped included). Number 137 is reserved for A1;
-- 138 is A2's JobDecisions. Never renumber.
--
-- RUNBOOK: apply 137 before the build that serves requestJobDecision.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID('dbo.JobDecisionRequests', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.JobDecisionRequests (
    RequestId           INT            IDENTITY(1,1) NOT NULL,
    JobId               INT            NOT NULL,
    Question            NVARCHAR(2000) NOT NULL,
    DecisionMakers      NVARCHAR(MAX)  NOT NULL,
    AssignmentMode      NVARCHAR(8)    NOT NULL,
    Tier                NVARCHAR(12)   NOT NULL,
    RespondBy           DATETIME2(3)   NULL,
    RoutineWeeks        INT            NULL,
    AutoEscalate        BIT            NOT NULL,
    SourceAttachmentId  INT            NULL,
    State               NVARCHAR(10)   NOT NULL CONSTRAINT DF_JobDecisionRequests_State DEFAULT N'pending',
    RequestedBy         NVARCHAR(200)  NOT NULL,
    RequestedByUserId   INT            NULL,
    RequestedAt         DATETIME2(3)   NOT NULL CONSTRAINT DF_JobDecisionRequests_RequestedAt DEFAULT SYSUTCDATETIME(),
    WithdrawnAt         DATETIME2(3)   NULL,
    WithdrawnBy         NVARCHAR(200)  NULL,
    WithdrawnByUserId   INT            NULL,
    WithdrawnReason     NVARCHAR(1000) NULL,
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT PK_JobDecisionRequests PRIMARY KEY CLUSTERED (RequestId),
    CONSTRAINT FK_JobDecisionRequests_Jobs FOREIGN KEY (JobId)
      REFERENCES dbo.Jobs(JobID),
    CONSTRAINT FK_JobDecisionRequests_Attachments FOREIGN KEY (SourceAttachmentId)
      REFERENCES dbo.Attachments(Id),
    CONSTRAINT CK_JobDecisionRequests_Question CHECK (LEN(LTRIM(RTRIM(Question))) > 0),
    CONSTRAINT CK_JobDecisionRequests_DecisionMakers CHECK (ISJSON(DecisionMakers) = 1),
    CONSTRAINT CK_JobDecisionRequests_AssignmentMode CHECK (AssignmentMode IN (N'named', N'role')),
    CONSTRAINT CK_JobDecisionRequests_Tier CHECK (Tier IN (N'emergency', N'urgent', N'soon', N'routine', N'fixed')),
    CONSTRAINT CK_JobDecisionRequests_State CHECK (State IN (N'pending', N'answered', N'withdrawn')),
    CONSTRAINT CK_JobDecisionRequests_RoutineWeeks CHECK (
      (Tier = N'routine' AND RoutineWeeks IS NOT NULL AND RoutineWeeks BETWEEN 2 AND 8)
      OR (Tier <> N'routine' AND RoutineWeeks IS NULL)
    ),
    CONSTRAINT CK_JobDecisionRequests_AutoEscalate CHECK (
      (Tier = N'emergency' AND AutoEscalate = 0)
      OR Tier = N'urgent'
      OR (Tier IN (N'soon', N'routine', N'fixed') AND AutoEscalate = 1)
    ),
    CONSTRAINT CK_JobDecisionRequests_RespondBy CHECK (
      (Tier = N'emergency' AND RespondBy IS NULL)
      OR (Tier <> N'emergency' AND RespondBy IS NOT NULL)
    ),
    CONSTRAINT CK_JobDecisionRequests_Withdrawn CHECK (
      (State = N'withdrawn' AND WithdrawnAt IS NOT NULL AND WithdrawnReason IS NOT NULL)
      OR (State <> N'withdrawn' AND WithdrawnAt IS NULL)
    )
  );
END
GO

-- Everything asked on one job, newest first (the job modal, the history).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_JobDecisionRequests_JobId' AND object_id = OBJECT_ID('dbo.JobDecisionRequests'))
  CREATE INDEX IX_JobDecisionRequests_JobId
    ON dbo.JobDecisionRequests (JobId, RequestId DESC)
    INCLUDE (State, Tier, RespondBy);
GO

-- One pending request per job: a second ask while one is open is a conflict, and
-- two simultaneous asks cannot both get in.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_JobDecisionRequests_Pending' AND object_id = OBJECT_ID('dbo.JobDecisionRequests'))
  CREATE UNIQUE INDEX UX_JobDecisionRequests_Pending
    ON dbo.JobDecisionRequests (JobId)
    WHERE State = N'pending';
GO

-- Which requests a file is the subject of (deleting that file is refused).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_JobDecisionRequests_SourceAttachment' AND object_id = OBJECT_ID('dbo.JobDecisionRequests'))
  CREATE INDEX IX_JobDecisionRequests_SourceAttachment
    ON dbo.JobDecisionRequests (SourceAttachmentId)
    WHERE SourceAttachmentId IS NOT NULL;
GO

-- Seed. The last value is Active. Urgent is 0 here: the request raises its
-- escalation as urgent itself when its tier is urgent or emergency.
;WITH Seed (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active) AS (
  SELECT * FROM (VALUES
    (N'job.decision_pending', N'authority', 0, N'business', N'yes',
      N'[{"userTarget":true},{"token":"raiser_manager","slaHours":16},{"role":"director"}]', 1)
  ) AS v (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active)
)
MERGE dbo.EscalationPolicies AS target
USING Seed AS source
  ON target.PolicyKey = source.PolicyKey
WHEN NOT MATCHED BY TARGET THEN
  INSERT (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy)
  VALUES (source.PolicyKey, source.Kind, source.Urgent, source.Clock, source.AutoReescalate, source.Ladder, source.Active, N'migration:137_job_decision_requests');
GO
