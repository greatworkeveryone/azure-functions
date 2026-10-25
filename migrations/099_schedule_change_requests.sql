-- Migration 099: pending schedule changes, ratified by a director (PLAN WP26c,
-- D23, D24, independent review M4).
--
-- Staff can ask for a change to a tenancy's rent schedule (today: rent relief
-- for a defined period), but it reaches the schedule only when a director
-- ratifies it. Until then it is pending: shown on the schedule and on every
-- read of rent, and in no figure.
--
--   dbo.ScheduleChangeRequests     one row per request
--     RequestId        a UUID, the decision ledger's subject id (schedule_change)
--     TenantId         the tenancy. The foreign key has no cascade: a tenancy
--                      with requests can't be hard-deleted out from under them
--     Kind             relief | ratchet_override | manual_change. Relief is the
--                      one asked for today; the other two are reserved so a later
--                      package never has to widen this check
--     Payload          the proposed change as JSON (a relief: { from, to, kind,
--                      value, scope }); ISJSON
--     Reason           why it is asked for; required
--     State            pending -> ratified or rejected (a director) or withdrawn
--                      (the person who asked); decided rows carry who and when
--     RequestedById/Name/At, DecidedById/Name/At, DecisionNote
--     Version          ROWVERSION: every decision sends back the one it read (409)
--   Indexes: (TenantId, State) for one tenancy's changes, (State, TenantId) for
--   every pending change (the warnings on each read of rent).
--
--   dbo.Tenants.RentReliefs        the ratified reliefs, JSON: an overlay on the
--                                  schedule, never a row of it (scheduleCharges.ts).
--                                  NULL = none
--   dbo.Tenants.CpiReferenceQuarterRule
--                                  the lease's CPI reference quarter (M4): NULL =
--                                  the default, quarter_before_review_date; or
--                                  latest_published_before_review
--
--   dbo.EscalationPolicies         schedule.change_ratification: authority, to the
--                                  directors (16 business hours, then reminders),
--                                  raised when a change is asked for and ended by
--                                  the director's decision or the withdrawal
--
-- Additive and re-runnable: every CREATE and ALTER sits behind an existence
-- check in a batch of its own; both new Tenants columns are NULL, so every
-- tenancy reads as having no relief and the default reference quarter, which is
-- true; the policy is seeded MERGE ... WHEN NOT MATCHED THEN INSERT only, as 098
-- seeds its own, so an admin's edit (a switch turned off included) is never
-- overwritten. Nothing is dropped, deleted, altered in place or rewritten.
--
-- The number is the plan's reservation for WP26c. On a database that already has
-- 101 the runner applies it out of order, with a warning only; it depends on
-- dbo.Tenants and on 098's dbo.EscalationPolicies (the seed waits for that table).
-- Apply it before the code that reads it: every read of rent does.

IF OBJECT_ID('dbo.ScheduleChangeRequests', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.ScheduleChangeRequests (
    RequestId        NVARCHAR(40)   NOT NULL,
    TenantId         INT            NOT NULL,
    Kind             NVARCHAR(20)   NOT NULL,
    Payload          NVARCHAR(MAX)  NOT NULL,
    Reason           NVARCHAR(2000) NOT NULL,
    State            NVARCHAR(16)   NOT NULL CONSTRAINT DF_ScheduleChangeRequests_State DEFAULT N'pending',
    RequestedById    INT            NULL,
    RequestedByName  NVARCHAR(200)  NOT NULL,
    RequestedAt      DATETIME2(3)   NOT NULL CONSTRAINT DF_ScheduleChangeRequests_RequestedAt DEFAULT SYSUTCDATETIME(),
    DecidedById      INT            NULL,
    DecidedByName    NVARCHAR(200)  NULL,
    DecidedAt        DATETIME2(3)   NULL,
    DecisionNote     NVARCHAR(2000) NULL,
    Version          ROWVERSION     NOT NULL,
    CONSTRAINT PK_ScheduleChangeRequests PRIMARY KEY (RequestId),
    CONSTRAINT FK_ScheduleChangeRequests_Tenant FOREIGN KEY (TenantId) REFERENCES dbo.Tenants (TenantId),
    CONSTRAINT CK_ScheduleChangeRequests_Kind CHECK (Kind IN (N'relief', N'ratchet_override', N'manual_change')),
    CONSTRAINT CK_ScheduleChangeRequests_State CHECK (State IN (N'pending', N'ratified', N'rejected', N'withdrawn')),
    CONSTRAINT CK_ScheduleChangeRequests_Payload CHECK (ISJSON(Payload) = 1),
    CONSTRAINT CK_ScheduleChangeRequests_Reason CHECK (LEN(Reason) > 0),
    CONSTRAINT CK_ScheduleChangeRequests_Decided CHECK (
      (State = N'pending' AND DecidedAt IS NULL)
      OR (State <> N'pending' AND DecidedAt IS NOT NULL AND DecidedByName IS NOT NULL)
    )
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ScheduleChangeRequests_Tenant' AND object_id = OBJECT_ID('dbo.ScheduleChangeRequests'))
  CREATE INDEX IX_ScheduleChangeRequests_Tenant
    ON dbo.ScheduleChangeRequests (TenantId, State)
    INCLUDE (Kind, RequestedAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ScheduleChangeRequests_State' AND object_id = OBJECT_ID('dbo.ScheduleChangeRequests'))
  CREATE INDEX IX_ScheduleChangeRequests_State
    ON dbo.ScheduleChangeRequests (State, TenantId)
    INCLUDE (Kind, RequestedAt);
GO

IF COL_LENGTH('dbo.Tenants', 'RentReliefs') IS NULL
  ALTER TABLE dbo.Tenants ADD RentReliefs NVARCHAR(MAX) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Tenants_RentReliefs' AND parent_object_id = OBJECT_ID('dbo.Tenants'))
  ALTER TABLE dbo.Tenants ADD CONSTRAINT CK_Tenants_RentReliefs CHECK (RentReliefs IS NULL OR ISJSON(RentReliefs) = 1);
GO

IF COL_LENGTH('dbo.Tenants', 'CpiReferenceQuarterRule') IS NULL
  ALTER TABLE dbo.Tenants ADD CpiReferenceQuarterRule NVARCHAR(32) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Tenants_CpiReferenceQuarterRule' AND parent_object_id = OBJECT_ID('dbo.Tenants'))
  ALTER TABLE dbo.Tenants ADD CONSTRAINT CK_Tenants_CpiReferenceQuarterRule
    CHECK (CpiReferenceQuarterRule IS NULL OR CpiReferenceQuarterRule IN (N'quarter_before_review_date', N'latest_published_before_review'));
GO

-- The ladder entry is { "role": ..., "slaHours": hours } (business hours on the
-- Darwin clock, 8 = one business day), as in 098. The last value is Active.
IF OBJECT_ID(N'dbo.EscalationPolicies', N'U') IS NOT NULL
BEGIN
  ;WITH Seed (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active) AS (
    SELECT * FROM (VALUES
      (N'schedule.change_ratification', N'authority', 0, N'business', N'reminder',
        N'[{"role":"director","slaHours":16}]', 1)
    ) AS v (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active)
  )
  MERGE dbo.EscalationPolicies AS target
  USING Seed AS source
    ON target.PolicyKey = source.PolicyKey
  WHEN NOT MATCHED BY TARGET THEN
    INSERT (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy)
    VALUES (source.PolicyKey, source.Kind, source.Urgent, source.Clock, source.AutoReescalate, source.Ladder, source.Active, N'migration:099_schedule_change_requests');
END
GO
