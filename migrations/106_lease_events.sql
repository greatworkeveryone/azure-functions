-- Migration 106: lease_events (PLAN WP32 option exercise, WP33 expiry and
-- renewal, D13; number pre-assigned in PLAN §7).
--
-- 1. Structured options on dbo.Tenants, so an option exercise can count down
--    and the window can be dated without re-reading free text:
--      OptionsTotal      how many options the lease grants
--      OptionsRemaining  how many are left to exercise (≤ OptionsTotal)
--      OptionTermMonths  the length of each option, in months
--    All NULL until the one-off backfill (scripts/backfill-lease-options.cjs,
--    dry run by default) fills them from OptionPeriods with WP19's parser, or an
--    option exercise or renewal writes them. NULL reads as "not recorded": the
--    app falls back to parsing OptionPeriods, as it did before.
--
-- 2. dbo.LeaseEvents: one row per lease event, type option_exercise or renewal
--    (src/leaseEventMachine.ts has the states). Its history is the decision
--    ledger (D13: no event-log tables), so the row holds where the event stands
--    and what was decided, and every transition writes a DecisionLedger row in
--    its own transaction. Never deleted: a closed event stays as the record of
--    the decision; ArchivedAt / ArchivedBy are there for the one way an event
--    could leave the lists (its tenancy archived), and nothing hard-deletes one.
--    Version is a rowversion: every write carries the one it read (409 when stale).
--    At most one open event of each type per tenancy (a filtered unique index).
--
-- 3. dbo.Vacancies.AvailableFrom (WP33): a renewal decided as "vacating" creates
--    a draft vacancy whose premises are available from the lease's expiry.
--
-- Additive and re-runnable: every CREATE and ALTER sits behind an existence
-- check in its own GO batch. Nothing is dropped, narrowed, renamed or
-- rewritten, and no existing row changes (the backfill is a separate script,
-- not part of this migration).
--
-- RUNBOOK: apply 106 before the build that reads these columns (the register
-- and the lease events endpoints name them). Dry-run it on a restored copy of
-- production first (database-safety rules, section 4).

IF COL_LENGTH('dbo.Tenants', 'OptionsTotal') IS NULL
  ALTER TABLE dbo.Tenants ADD OptionsTotal INT NULL;
GO

IF COL_LENGTH('dbo.Tenants', 'OptionsRemaining') IS NULL
  ALTER TABLE dbo.Tenants ADD OptionsRemaining INT NULL;
GO

IF COL_LENGTH('dbo.Tenants', 'OptionTermMonths') IS NULL
  ALTER TABLE dbo.Tenants ADD OptionTermMonths INT NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_Tenants_Options' AND parent_object_id = OBJECT_ID('dbo.Tenants')
)
  ALTER TABLE dbo.Tenants ADD CONSTRAINT CK_Tenants_Options
    CHECK (
      (OptionsTotal IS NULL OR OptionsTotal BETWEEN 0 AND 20)
      AND (OptionsRemaining IS NULL OR OptionsRemaining >= 0)
      AND (OptionsRemaining IS NULL OR OptionsTotal IS NULL OR OptionsRemaining <= OptionsTotal)
      AND (OptionTermMonths IS NULL OR OptionTermMonths BETWEEN 1 AND 600)
    );
GO

IF OBJECT_ID('dbo.LeaseEvents', 'U') IS NULL
  CREATE TABLE dbo.LeaseEvents (
    LeaseEventId      NVARCHAR(40)    NOT NULL CONSTRAINT PK_LeaseEvents PRIMARY KEY,
    TenantId          INT             NOT NULL CONSTRAINT FK_LeaseEvents_Tenant REFERENCES dbo.Tenants (TenantId),
    BuildingId        INT             NULL,
    Type              NVARCHAR(20)    NOT NULL,
    State             NVARCHAR(20)    NOT NULL,
    -- The lease expiry the event is about; an approval refuses if it has moved.
    LeaseExpiry       DATE            NULL,
    -- Option window: first day notice can be given, and the last.
    WindowOpensOn     DATE            NULL,
    DeadlineOn        DATE            NULL,
    -- The tenant's notice: the date it was given and the document it came in.
    NoticeDate        DATE            NULL,
    NoticeDocument    NVARCHAR(500)   NULL,
    LateNotice        BIT             NOT NULL CONSTRAINT DF_LeaseEvents_LateNotice DEFAULT 0,
    -- The option term and how its rent moves, as recorded with the notice (JSON).
    Terms             NVARCHAR(MAX)   NULL,
    RecordedById      INT             NULL,
    RecordedByName    NVARCHAR(200)   NULL,
    RecordedAt        DATETIME2       NULL,
    DecidedById       INT             NULL,
    DecidedByName     NVARCHAR(200)   NULL,
    DecidedAt         DATETIME2       NULL,
    Outcome           NVARCHAR(20)    NULL,
    OutcomeDetails    NVARCHAR(MAX)   NULL,
    OutcomeReason     NVARCHAR(2000)  NULL,
    CreatedAt         DATETIME2       NOT NULL CONSTRAINT DF_LeaseEvents_CreatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedAt         DATETIME2       NOT NULL CONSTRAINT DF_LeaseEvents_UpdatedAt DEFAULT SYSUTCDATETIME(),
    ArchivedAt        DATETIME2       NULL,
    ArchivedBy        NVARCHAR(200)   NULL,
    Version           ROWVERSION      NOT NULL,
    CONSTRAINT CK_LeaseEvents_Type CHECK (Type IN ('option_exercise', 'renewal')),
    CONSTRAINT CK_LeaseEvents_State CHECK (State IN (
      'window_not_open', 'window_open', 'notice_received', 'awaiting_approval',
      'exercised', 'rejected', 'lapsed',
      'referred', 'renewed', 'vacating', 'holdover',
      'cancelled'
    )),
    CONSTRAINT CK_LeaseEvents_Outcome CHECK (Outcome IS NULL OR Outcome IN (
      'exercised', 'rejected', 'lapsed', 'renewed', 'vacating', 'holdover', 'cancelled'
    )),
    CONSTRAINT CK_LeaseEvents_Terms CHECK (Terms IS NULL OR ISJSON(Terms) = 1),
    CONSTRAINT CK_LeaseEvents_OutcomeDetails CHECK (OutcomeDetails IS NULL OR ISJSON(OutcomeDetails) = 1)
  );
GO

-- One open event of each type per tenancy. The five open states are the ones
-- a decision is still owed in; a closed event falls outside the filter, so a
-- tenancy keeps every event it has had.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'UX_LeaseEvents_OpenPerType' AND object_id = OBJECT_ID('dbo.LeaseEvents')
)
  CREATE UNIQUE INDEX UX_LeaseEvents_OpenPerType
    ON dbo.LeaseEvents (TenantId, Type)
    WHERE State IN ('window_not_open', 'window_open', 'notice_received', 'awaiting_approval', 'referred');
GO

-- A tenancy's events, newest first (the tenancy page and the generator).
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_LeaseEvents_Tenant' AND object_id = OBJECT_ID('dbo.LeaseEvents')
)
  CREATE INDEX IX_LeaseEvents_Tenant
    ON dbo.LeaseEvents (TenantId, CreatedAt);
GO

IF COL_LENGTH('dbo.Vacancies', 'AvailableFrom') IS NULL
  ALTER TABLE dbo.Vacancies ADD AvailableFrom DATE NULL;
GO
