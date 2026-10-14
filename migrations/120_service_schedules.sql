-- Migration 120: dbo.ServiceSchedules and dbo.ServiceScheduleRuns (WP50; sprint F2).
--
-- Adam's maintenance tracker: one row per recurring service, attached to an
-- asset (Assets, migration 113) or, when there is no asset, to a described
-- scope ("All emergency exit lights") and optionally a location. It recurs every
-- IntervalCount weeks or months from AnchorDate; NextDue is the next occurrence
-- not yet done. The facilities scheduler (schedulerTimer) creates the
-- maintenance job LeadDays before NextDue and records it in ServiceScheduleRuns.
--
--   ServiceScheduleRuns  one row per schedule and due date. The unique index on
--                        (ServiceScheduleId, DueDate) is the idempotency guard:
--                        a second run for the same due date cannot insert, so
--                        a job can never be generated twice. Outcome is
--                        job_created (JobId set), skipped_defects (the due date
--                        fell inside a blocking defects period; DefectsPeriodId
--                        says which), recorded (a manager marked it serviced
--                        without a Floorplan job, or the import brought in the
--                        last service date) or skipped (a manager skipped this
--                        due date, with the reason in Note). CompletedAt is
--                        stamped when the service was done, which also advances
--                        NextDue.
--
-- Rows are archived (ArchivedAt/ArchivedBy), never deleted; Active = 0 pauses a
-- schedule without archiving it. RowVersion makes a stale edit a 409.
-- ContractorId carries no foreign key (contractors are synced from upstream).
--
-- Also seeds the overdue policies for the service_schedule escalation adapter:
-- urgent for Fire & life safety and Lifts (wall clock, moves up to directors),
-- digest for the rest. Insert-only, so an admin's edits survive a re-run.
--
-- Additive and re-runnable. Numbering: 120 is reserved for WP50. Never renumber.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID('dbo.ServiceSchedules', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ServiceSchedules (
        ServiceScheduleId    INT            IDENTITY(1,1) NOT NULL,
        BuildingId           INT            NOT NULL,
        AssetId              INT            NULL,
        LocationId           INT            NULL,
        Scope                NVARCHAR(200)  NULL,
        Category             NVARCHAR(50)   NOT NULL,
        Name                 NVARCHAR(200)  NOT NULL,
        ContractorId         INT            NULL,
        IsContract           BIT            NOT NULL CONSTRAINT DF_ServiceSchedules_IsContract DEFAULT 0,
        IntervalCount        INT            NOT NULL,
        IntervalUnit         NVARCHAR(10)   NOT NULL,
        AnchorDate           DATE           NOT NULL,
        LeadDays             INT            NOT NULL CONSTRAINT DF_ServiceSchedules_LeadDays DEFAULT 14,
        NextDue              DATE           NOT NULL,
        LastCompletedJobId   INT            NULL,
        Active               BIT            NOT NULL CONSTRAINT DF_ServiceSchedules_Active DEFAULT 1,
        Notes                NVARCHAR(2000) NULL,
        CreatedAt            DATETIME2      NOT NULL CONSTRAINT DF_ServiceSchedules_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBy            NVARCHAR(200)  NULL,
        UpdatedAt            DATETIME2      NOT NULL CONSTRAINT DF_ServiceSchedules_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBy            NVARCHAR(200)  NULL,
        ArchivedAt           DATETIME2      NULL,
        ArchivedBy           NVARCHAR(200)  NULL,
        RowVersion           ROWVERSION     NOT NULL,
        CONSTRAINT PK_ServiceSchedules PRIMARY KEY (ServiceScheduleId),
        CONSTRAINT FK_ServiceSchedules_Buildings FOREIGN KEY (BuildingId)
            REFERENCES dbo.Buildings(BuildingID),
        CONSTRAINT FK_ServiceSchedules_Assets FOREIGN KEY (AssetId)
            REFERENCES dbo.Assets(AssetId),
        CONSTRAINT FK_ServiceSchedules_Locations FOREIGN KEY (LocationId)
            REFERENCES dbo.Locations(LocationId),
        CONSTRAINT CK_ServiceSchedules_IntervalUnit CHECK (IntervalUnit IN (N'weeks', N'months')),
        CONSTRAINT CK_ServiceSchedules_IntervalCount CHECK (IntervalCount BETWEEN 1 AND 520),
        CONSTRAINT CK_ServiceSchedules_LeadDays CHECK (LeadDays BETWEEN 0 AND 365),
        CONSTRAINT CK_ServiceSchedules_Target CHECK (AssetId IS NOT NULL OR Scope IS NOT NULL)
    );
END
GO

-- The scheduler's daily question: active, live schedules whose next due is near.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ServiceSchedules_NextDue_Live' AND object_id = OBJECT_ID('dbo.ServiceSchedules'))
    CREATE INDEX IX_ServiceSchedules_NextDue_Live
        ON dbo.ServiceSchedules (NextDue)
        INCLUDE (BuildingId, AssetId, Category, LeadDays)
        WHERE Active = 1 AND ArchivedAt IS NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ServiceSchedules_Building' AND object_id = OBJECT_ID('dbo.ServiceSchedules'))
    CREATE INDEX IX_ServiceSchedules_Building ON dbo.ServiceSchedules (BuildingId, AssetId);
GO

IF OBJECT_ID('dbo.ServiceScheduleRuns', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ServiceScheduleRuns (
        ServiceScheduleRunId INT            IDENTITY(1,1) NOT NULL,
        ServiceScheduleId    INT            NOT NULL,
        DueDate              DATE           NOT NULL,
        JobId                INT            NULL,
        Outcome              NVARCHAR(20)   NOT NULL,
        DefectsPeriodId      INT            NULL,
        CompletedAt          DATETIME2      NULL,
        Note                 NVARCHAR(500)  NULL,
        CreatedAt            DATETIME2      NOT NULL CONSTRAINT DF_ServiceScheduleRuns_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBy            NVARCHAR(200)  NULL,
        CONSTRAINT PK_ServiceScheduleRuns PRIMARY KEY (ServiceScheduleRunId),
        CONSTRAINT FK_ServiceScheduleRuns_Schedules FOREIGN KEY (ServiceScheduleId)
            REFERENCES dbo.ServiceSchedules(ServiceScheduleId),
        CONSTRAINT FK_ServiceScheduleRuns_Jobs FOREIGN KEY (JobId)
            REFERENCES dbo.Jobs(JobID),
        CONSTRAINT CK_ServiceScheduleRuns_Outcome CHECK (Outcome IN (N'job_created', N'skipped_defects', N'recorded', N'skipped')),
        CONSTRAINT CK_ServiceScheduleRuns_Shape CHECK (
            (Outcome = N'job_created' AND JobId IS NOT NULL)
            OR (Outcome <> N'job_created' AND JobId IS NULL)
        )
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_ServiceScheduleRuns_Schedule_Due' AND object_id = OBJECT_ID('dbo.ServiceScheduleRuns'))
    CREATE UNIQUE INDEX UX_ServiceScheduleRuns_Schedule_Due
        ON dbo.ServiceScheduleRuns (ServiceScheduleId, DueDate);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ServiceScheduleRuns_Job' AND object_id = OBJECT_ID('dbo.ServiceScheduleRuns'))
    CREATE INDEX IX_ServiceScheduleRuns_Job ON dbo.ServiceScheduleRuns (JobId) WHERE JobId IS NOT NULL;
GO

IF OBJECT_ID('dbo.EscalationPolicies', 'U') IS NOT NULL
BEGIN
    MERGE dbo.EscalationPolicies AS target
    USING (VALUES
        (N'service_schedule.overdue', N'attention', 0, N'business', N'no', N'[{"role":"facilities_manager"}]', 1),
        (N'service_schedule.overdue_urgent', N'attention', 1, N'wall', N'yes',
          N'[{"role":"facilities_manager","slaHours":24},{"role":"director","slaHours":48}]', 1)
    ) AS source (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active)
      ON target.PolicyKey = source.PolicyKey
    WHEN NOT MATCHED BY TARGET THEN
      INSERT (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy)
      VALUES (source.PolicyKey, source.Kind, source.Urgent, source.Clock, source.AutoReescalate, source.Ladder, source.Active, N'migration:120_service_schedules');
END
GO
