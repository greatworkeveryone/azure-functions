-- 037_tenancy_register.sql
--
-- Tenancy Register (v2). Replaces the lightweight Tenants table from
-- migration 015 with a full tenant record (lease, contact, rent, review,
-- security deposit) plus four sibling tables that together model the
-- spreadsheet you're migrating from:
--
--   Tenants                    one row per tenant entity (identity + lease)
--   TenantOccupancies          one row per (level × area) cell — the
--                              spreadsheet's "merged cell" semantics; a
--                              tenant on Level 3 areas A+B and Level 4 area A
--                              has 3 rows here
--   TenantNotes                sticky notes anchored to a tenant, an
--                              occupancy, or a single field — sparse
--   TenantOccupancyHistory     append-only snapshots for the "previous years"
--                              detail view
--   RentReviews                review log + alerts source (drives the
--                              traffic-light state on the schedule)
--   CpiIndex                   monthly cache of ABS CPI index values; written
--                              by the cpiSyncTimer function, read by the
--                              "Apply CPI review" flow
--
-- Destructive on Tenants: the existing table only holds spreadsheet/sample
-- data. To stay re-runnable the destructive block is gated on a column from
-- the OLD shape (`TenantName`); once the new schema is in place the block is
-- a no-op on subsequent runs.
--
-- Children of Tenants use NVARCHAR(40) UUIDs (client-generated) so the
-- spreadsheet paste-import flow can mint IDs offline, matching the
-- Inspections pattern. Tenants itself stays INT IDENTITY because Jobs.TenantID
-- already FKs to it.

-- ── Drop existing FKs + table (idempotent) ───────────────────────────────────
-- Drop every FK that references dbo.Tenants, not just the named ones — earlier
-- migrations (e.g. 030_create_keys) declared inline FKs whose names are
-- auto-generated and unknowable here.

IF OBJECT_ID('dbo.Tenants', 'U') IS NOT NULL
BEGIN
  DECLARE @sql NVARCHAR(MAX) = N'';
  SELECT @sql = @sql + N'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id))
                     + N'.' + QUOTENAME(OBJECT_NAME(parent_object_id))
                     + N' DROP CONSTRAINT ' + QUOTENAME(name) + N';' + CHAR(10)
    FROM sys.foreign_keys
   WHERE referenced_object_id = OBJECT_ID('dbo.Tenants');
  IF LEN(@sql) > 0 EXEC sp_executesql @sql;
END
GO

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants') AND name = 'TenantName'
)
  DROP TABLE dbo.Tenants;
GO

-- ── Tenants ──────────────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Tenants')
BEGIN
  CREATE TABLE dbo.Tenants (
    -- Identity
    TenantId                    INT IDENTITY(1,1) PRIMARY KEY,
    BuildingId                  INT            NOT NULL,
    IdNo                        NVARCHAR(50)   NULL,
    MyobId                      NVARCHAR(100)  NULL,
    LegalName                   NVARCHAR(255)  NOT NULL,
    TradingName                 NVARCHAR(255)  NULL,
    Acn                         NVARCHAR(20)   NULL,
    Abn                         NVARCHAR(20)   NULL,

    -- Contact
    PostalAddress               NVARCHAR(500)  NULL,
    AccountsPhone               NVARCHAR(50)   NULL,
    AccountsEmail               NVARCHAR(255)  NULL,
    PrimaryContactName          NVARCHAR(200)  NULL,
    PrimaryContactEmail         NVARCHAR(255)  NULL,
    PrimaryContactPhone         NVARCHAR(50)   NULL,

    -- Lease term
    Commencement                DATE           NULL,
    Expiry                      DATE           NULL,
    TermMonths                  INT            NULL,
    OptionPeriods               NVARCHAR(500)  NULL,
    OptionNoticeMonths          INT            NULL,
    RenewalLetterIssueBy        DATE           NULL,

    -- Rent
    RentBasis                   NVARCHAR(20)   NOT NULL DEFAULT 'fixedAnnual',
    RentPerAnnum                DECIMAL(12,2)  NULL,
    RentPerSqm                  DECIMAL(12,2)  NULL,

    -- Review
    ReviewType                  NVARCHAR(20)   NOT NULL DEFAULT 'none',
    ReviewIntervalMonths        INT            NULL,
    NextReviewDate              DATE           NULL,
    LastReviewDate              DATE           NULL,
    LastReviewIncreasePercent   DECIMAL(5,2)   NULL,
    FixedReviewPercent          DECIMAL(5,2)   NULL,
    CpiRegion                   NVARCHAR(20)   NULL,
    CpiCapPercent               DECIMAL(5,2)   NULL,
    CpiFloorPercent             DECIMAL(5,2)   NULL,

    -- Security deposit
    SecurityDepositRequired     DECIMAL(12,2)  NULL,
    SecurityDepositMethod       NVARCHAR(30)   NULL,
    SecurityDepositHeld         DECIMAL(12,2)  NULL,

    -- Misc
    Status                      NVARCHAR(20)   NOT NULL DEFAULT 'current',
    Comments                    NVARCHAR(MAX)  NULL,
    EscalationPercent           DECIMAL(5,2)   NULL,
    EscalationSchedule          NVARCHAR(MAX)  NULL,

    -- Audit
    CreatedAt                   DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt                   DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    CreatedById                 NVARCHAR(200)  NOT NULL,
    CreatedByName               NVARCHAR(200)  NOT NULL,
    UpdatedById                 NVARCHAR(200)  NOT NULL,
    UpdatedByName               NVARCHAR(200)  NOT NULL,

    CONSTRAINT CK_Tenants_RentBasis
      CHECK (RentBasis IN ('fixedAnnual','perSqm','custom')),
    CONSTRAINT CK_Tenants_ReviewType
      CHECK (ReviewType IN ('none','fixedPercent','cpi','marketReview')),
    CONSTRAINT CK_Tenants_CpiRegion
      CHECK (CpiRegion IS NULL OR CpiRegion IN ('AUS','DARWIN')),
    CONSTRAINT CK_Tenants_SecurityDepositMethod
      CHECK (SecurityDepositMethod IS NULL
             OR SecurityDepositMethod IN ('cash','bankGuarantee','bond','other')),
    CONSTRAINT CK_Tenants_Status
      CHECK (Status IN ('current','holdover','vacated','pending'))
  );

  CREATE INDEX IX_Tenants_BuildingId      ON dbo.Tenants(BuildingId);
  CREATE INDEX IX_Tenants_Status          ON dbo.Tenants(Status);
  CREATE INDEX IX_Tenants_NextReviewDate  ON dbo.Tenants(NextReviewDate)
    WHERE NextReviewDate IS NOT NULL;
  CREATE INDEX IX_Tenants_Expiry          ON dbo.Tenants(Expiry)
    WHERE Expiry IS NOT NULL;
  CREATE INDEX IX_Tenants_MyobId          ON dbo.Tenants(MyobId)
    WHERE MyobId IS NOT NULL;
END
GO

-- Re-attach FKs to Tenants that we dropped above. Column types already match;
-- identity values are reset because Tenants was recreated so any pre-existing
-- TenantId references would dangle — expected since pre-migration rows are
-- sample data per the plan.

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Jobs_Tenants')
  ALTER TABLE dbo.Jobs
    ADD CONSTRAINT FK_Jobs_Tenants FOREIGN KEY (TenantID)
      REFERENCES dbo.Tenants(TenantId);
GO

IF OBJECT_ID('dbo.Keys', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Keys_Tenants')
  ALTER TABLE dbo.Keys
    ADD CONSTRAINT FK_Keys_Tenants FOREIGN KEY (TenancyId)
      REFERENCES dbo.Tenants(TenantId);
GO

-- ── TenantOccupancies (the merged-cell rep) ──────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'TenantOccupancies')
BEGIN
  CREATE TABLE dbo.TenantOccupancies (
    OccupancyId                  NVARCHAR(40)   PRIMARY KEY,
    TenantId                     INT            NOT NULL,
    BuildingId                   INT            NOT NULL,
    Level                        NVARCHAR(100)  NOT NULL,
    Area                         NVARCHAR(100)  NOT NULL,
    SizeSqm                      DECIMAL(10,2)  NOT NULL,
    BusinessTenanciesActApplies  BIT            NULL,
    Notes                        NVARCHAR(500)  NULL,
    CreatedAt                    DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt                    DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_TenantOccupancies_Tenant
      FOREIGN KEY (TenantId) REFERENCES dbo.Tenants(TenantId) ON DELETE CASCADE
  );

  CREATE INDEX IX_TenantOccupancies_Tenant   ON dbo.TenantOccupancies(TenantId);
  CREATE INDEX IX_TenantOccupancies_Building ON dbo.TenantOccupancies(BuildingId);
  -- Two tenants can't occupy the same cell.
  CREATE UNIQUE INDEX UX_TenantOccupancies_Cell
    ON dbo.TenantOccupancies(BuildingId, Level, Area);
END
GO

-- ── TenantNotes (sticky notes) ───────────────────────────────────────────────
-- AnchorKind discriminates: tenant-wide / occupancy-cell / single-field. The
-- relevant ID column is populated to match.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'TenantNotes')
BEGIN
  CREATE TABLE dbo.TenantNotes (
    NoteId         NVARCHAR(40)   PRIMARY KEY,
    TenantId       INT            NOT NULL,
    AnchorKind     NVARCHAR(20)   NOT NULL,
    OccupancyId    NVARCHAR(40)   NULL,
    FieldKey       NVARCHAR(100)  NULL,
    Body           NVARCHAR(MAX)  NOT NULL,
    CreatedAt      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    CreatedById    NVARCHAR(200)  NOT NULL,
    CreatedByName  NVARCHAR(200)  NOT NULL,

    CONSTRAINT FK_TenantNotes_Tenant
      FOREIGN KEY (TenantId) REFERENCES dbo.Tenants(TenantId) ON DELETE CASCADE,
    CONSTRAINT CK_TenantNotes_AnchorKind
      CHECK (AnchorKind IN ('tenant','occupancy','field')),
    CONSTRAINT CK_TenantNotes_AnchorShape
      CHECK (
        (AnchorKind = 'tenant'    AND OccupancyId IS NULL  AND FieldKey IS NULL)
     OR (AnchorKind = 'occupancy' AND OccupancyId IS NOT NULL AND FieldKey IS NULL)
     OR (AnchorKind = 'field'     AND FieldKey IS NOT NULL)
      )
  );

  CREATE INDEX IX_TenantNotes_Tenant     ON dbo.TenantNotes(TenantId);
  CREATE INDEX IX_TenantNotes_Occupancy  ON dbo.TenantNotes(OccupancyId)
    WHERE OccupancyId IS NOT NULL;
END
GO

-- ── TenantOccupancyHistory (append-only) ─────────────────────────────────────
-- Every upsertOccupancy writes a row here so the detail view can render the
-- "previous years" timeline without complicating the live table. Snapshot is
-- the full row JSON, future-proofing against column changes.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'TenantOccupancyHistory')
BEGIN
  CREATE TABLE dbo.TenantOccupancyHistory (
    HistoryId       NVARCHAR(40)   PRIMARY KEY,
    OccupancyId     NVARCHAR(40)   NOT NULL,
    TenantId        INT            NOT NULL,
    EffectiveFrom   DATE           NOT NULL,
    EffectiveTo     DATE           NULL,
    SizeSqm         DECIMAL(10,2)  NOT NULL,
    RentPerAnnum    DECIMAL(12,2)  NULL,
    RentPerSqm      DECIMAL(12,2)  NULL,
    Snapshot        NVARCHAR(MAX)  NOT NULL,
    CreatedAt       DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_TenantOccupancyHistory_Occupancy
      FOREIGN KEY (OccupancyId) REFERENCES dbo.TenantOccupancies(OccupancyId)
        ON DELETE CASCADE
  );

  CREATE INDEX IX_TenantOccupancyHistory_Occupancy
    ON dbo.TenantOccupancyHistory(OccupancyId);
  CREATE INDEX IX_TenantOccupancyHistory_Tenant
    ON dbo.TenantOccupancyHistory(TenantId);
END
GO

-- ── RentReviews (review log + traffic-light source) ──────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'RentReviews')
BEGIN
  CREATE TABLE dbo.RentReviews (
    ReviewId          NVARCHAR(40)   PRIMARY KEY,
    TenantId          INT            NOT NULL,
    ScheduledFor      DATE           NOT NULL,
    Status            NVARCHAR(20)   NOT NULL DEFAULT 'upcoming',
    ReviewType        NVARCHAR(20)   NOT NULL,
    OldRentPerAnnum   DECIMAL(12,2)  NULL,
    NewRentPerAnnum   DECIMAL(12,2)  NULL,
    IncreasePercent   DECIMAL(5,2)   NULL,
    CpiIndexUsed      NVARCHAR(100)  NULL,
    CpiBaseValue      DECIMAL(10,3)  NULL,
    CpiCurrentValue   DECIMAL(10,3)  NULL,
    CompletedAt       DATETIME2      NULL,
    CompletedById     NVARCHAR(200)  NULL,
    CompletedByName   NVARCHAR(200)  NULL,
    Notes             NVARCHAR(MAX)  NULL,
    CreatedAt         DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_RentReviews_Tenant
      FOREIGN KEY (TenantId) REFERENCES dbo.Tenants(TenantId) ON DELETE CASCADE,
    CONSTRAINT CK_RentReviews_Status
      CHECK (Status IN ('upcoming','due','overdue','completed','skipped')),
    CONSTRAINT CK_RentReviews_ReviewType
      CHECK (ReviewType IN ('none','fixedPercent','cpi','marketReview'))
  );

  CREATE INDEX IX_RentReviews_Tenant       ON dbo.RentReviews(TenantId);
  CREATE INDEX IX_RentReviews_ScheduledFor ON dbo.RentReviews(ScheduledFor);
  CREATE INDEX IX_RentReviews_Status       ON dbo.RentReviews(Status);
END
GO

-- ── CpiIndex (cache of ABS CPI values) ───────────────────────────────────────
-- (Region, Period) is the natural key. Period is an ISO-ish quarter string
-- e.g. '2026-Q1' so it sorts lexicographically.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'CpiIndex')
BEGIN
  CREATE TABLE dbo.CpiIndex (
    Region      NVARCHAR(20)   NOT NULL,
    Period      NVARCHAR(20)   NOT NULL,
    IndexValue  DECIMAL(10,3)  NOT NULL,
    FetchedAt   DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    PRIMARY KEY (Region, Period),
    CONSTRAINT CK_CpiIndex_Region CHECK (Region IN ('AUS','DARWIN'))
  );
END
GO
