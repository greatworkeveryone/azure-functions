-- 182_tenant_request_intake (TR1, PLAN §15): acknowledgement as a step of job intake.
--
--   dbo.WorkRequests (seven new columns, all NULL, nothing backfilled or rewritten)
--     IntakeState         NULL, 'received' or the Facilities click that moved it on:
--                         'acknowledged', 'assessing', 'closed_duplicate', 'closed_not_ours'.
--                         NULL reads as received. "Job raised" is not stored: it is whether a
--                         Job points at the request (Jobs.WorkRequestID), so it can never drift.
--     AcknowledgedAt / AcknowledgedBy / AcknowledgedVia
--                         when, who (a person's name) and how: 'email' (request_ack sent from
--                         notices@ through the comms core) or 'other' (told by phone, in person).
--     AcknowledgementJobId  the comms job (dbo.Correspondence.CorrespondenceId) the email went
--                         through. No foreign key: the record outlives the correspondence.
--     IntakeClosedReason  the plain sentence given when it was closed as a duplicate or not ours.
--     IntakeUpdatedAt     last intake move.
--
--   dbo.IntakeResponseTargets   one row per priority (Critical, High, Normal, Low): how many
--                         business hours Facilities promises to acknowledge within. NULL means
--                         no promise: no clock, no escalation. SetAt is when the target was last
--                         set; only requests received after it count, so setting a target never
--                         raises the backlog.
--
--   dbo.EscalationPolicies  request.unacknowledged (insert only): the ladder an overdue
--                         acknowledgement is chased up. The sweep raises it only for a priority
--                         with a target; with none set it raises nothing.
--
-- Additive and re-runnable: every object behind an existence check, each ADD in its own batch.

IF COL_LENGTH(N'dbo.WorkRequests', N'IntakeState') IS NULL
  ALTER TABLE dbo.WorkRequests ADD IntakeState NVARCHAR(24) NULL;
GO

IF COL_LENGTH(N'dbo.WorkRequests', N'AcknowledgedAt') IS NULL
  ALTER TABLE dbo.WorkRequests ADD AcknowledgedAt DATETIME2 NULL;
GO

IF COL_LENGTH(N'dbo.WorkRequests', N'AcknowledgedBy') IS NULL
  ALTER TABLE dbo.WorkRequests ADD AcknowledgedBy NVARCHAR(160) NULL;
GO

IF COL_LENGTH(N'dbo.WorkRequests', N'AcknowledgedVia') IS NULL
  ALTER TABLE dbo.WorkRequests ADD AcknowledgedVia NVARCHAR(16) NULL;
GO

IF COL_LENGTH(N'dbo.WorkRequests', N'AcknowledgementJobId') IS NULL
  ALTER TABLE dbo.WorkRequests ADD AcknowledgementJobId INT NULL;
GO

IF COL_LENGTH(N'dbo.WorkRequests', N'IntakeClosedReason') IS NULL
  ALTER TABLE dbo.WorkRequests ADD IntakeClosedReason NVARCHAR(300) NULL;
GO

IF COL_LENGTH(N'dbo.WorkRequests', N'IntakeUpdatedAt') IS NULL
  ALTER TABLE dbo.WorkRequests ADD IntakeUpdatedAt DATETIME2 NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_WorkRequests_IntakeState')
  ALTER TABLE dbo.WorkRequests ADD CONSTRAINT CK_WorkRequests_IntakeState
    CHECK (IntakeState IS NULL OR IntakeState IN (N'received', N'acknowledged', N'assessing', N'closed_duplicate', N'closed_not_ours'));
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_WorkRequests_AcknowledgedVia')
  ALTER TABLE dbo.WorkRequests ADD CONSTRAINT CK_WorkRequests_AcknowledgedVia
    CHECK (AcknowledgedVia IS NULL OR AcknowledgedVia IN (N'email', N'other'));
GO

IF OBJECT_ID(N'dbo.IntakeResponseTargets', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.IntakeResponseTargets (
    Priority                NVARCHAR(16) NOT NULL,
    AckWithinBusinessHours  INT          NULL,
    SetAt                   DATETIME2    NULL,
    SetBy                   NVARCHAR(160) NULL,
    CONSTRAINT PK_IntakeResponseTargets PRIMARY KEY (Priority),
    CONSTRAINT CK_IntakeResponseTargets_Priority CHECK (Priority IN (N'Critical', N'High', N'Normal', N'Low')),
    CONSTRAINT CK_IntakeResponseTargets_Hours CHECK (AckWithinBusinessHours IS NULL OR (AckWithinBusinessHours BETWEEN 1 AND 720))
  );
END
GO

;WITH Seed (Priority) AS (
  SELECT * FROM (VALUES (N'Critical'), (N'High'), (N'Normal'), (N'Low')) AS v (Priority)
)
MERGE dbo.IntakeResponseTargets AS target
USING Seed AS source
  ON target.Priority = source.Priority
WHEN NOT MATCHED BY TARGET THEN
  INSERT (Priority, AckWithinBusinessHours) VALUES (source.Priority, NULL);
GO

;WITH Seed (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active) AS (
  SELECT * FROM (VALUES
    (N'request.unacknowledged', N'attention', 0, N'business', N'yes',
      N'[{"role":"facilities_manager","slaHours":8},{"role":"director","slaHours":16}]', 1)
  ) AS v (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active)
)
MERGE dbo.EscalationPolicies AS target
USING Seed AS source
  ON target.PolicyKey = source.PolicyKey
WHEN NOT MATCHED BY TARGET THEN
  INSERT (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy)
  VALUES (source.PolicyKey, source.Kind, source.Urgent, source.Clock, source.AutoReescalate, source.Ladder, source.Active, N'migration:182_tenant_request_intake');
GO
