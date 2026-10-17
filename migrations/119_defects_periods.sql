-- Migration 119: dbo.DefectsPeriods (LAUNCH-READINESS §5, WP47/WP48; sprint F1).
--
-- After project works reach practical completion the builder owes defect
-- rectification (often servicing of the new plant too) for the defects
-- liability period. One row per period; Floorplan blocks RP's own planned
-- maintenance on that scope and warns on reactive work and invoices.
--
--   Scope        building | level | tenancy (building contains level contains tenancy)
--   LevelName    level scope: the level's name (validated against Buildings.Levels)
--   LocationId   level scope: the Locations row (migration 113), when known
--   TenantId     tenancy scope
--   Services     N'all', or a JSON array of maintenance categories
--   Enforcement  block (planned maintenance refused; managers may book anyway
--                with a reason) | warn (never refuses)
--
-- Rows are archived (ArchivedAt/ArchivedBy), never deleted. RowVersion makes a
-- stale edit a 409 instead of silently overwriting someone else's change.
-- TenantId and ContractorId carry no foreign key on purpose: tenants and
-- contractors can be removed upstream, and a period must survive that.
--
-- Also seeds the two reminder policies for the defects_period escalation
-- adapter (60 and 30 days before the end; digest, not urgent). Insert-only, so
-- running this again never overwrites a policy an admin has edited.
--
-- Additive and re-runnable: every statement is behind an existence check.
-- Numbering: 119 is reserved for WP47 (LAUNCH-READINESS §12). Never renumber.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID('dbo.DefectsPeriods', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.DefectsPeriods (
        DefectsPeriodId      INT            IDENTITY(1,1) NOT NULL,
        BuildingId           INT            NOT NULL,
        Scope                NVARCHAR(10)   NOT NULL,
        LevelName            NVARCHAR(100)  NULL,
        LocationId           INT            NULL,
        TenantId             INT            NULL,
        Services             NVARCHAR(1000) NOT NULL CONSTRAINT DF_DefectsPeriods_Services DEFAULT N'all',
        Works                NVARCHAR(200)  NOT NULL,
        ContractorId         INT            NULL,
        ContractorContact    NVARCHAR(400)  NULL,
        PracticalCompletion  DATE           NOT NULL,
        EndsOn               DATE           NOT NULL,
        Enforcement          NVARCHAR(10)   NOT NULL CONSTRAINT DF_DefectsPeriods_Enforcement DEFAULT N'block',
        Notes                NVARCHAR(2000) NULL,
        CreatedAt            DATETIME2      NOT NULL CONSTRAINT DF_DefectsPeriods_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBy            NVARCHAR(200)  NULL,
        UpdatedAt            DATETIME2      NOT NULL CONSTRAINT DF_DefectsPeriods_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBy            NVARCHAR(200)  NULL,
        ArchivedAt           DATETIME2      NULL,
        ArchivedBy           NVARCHAR(200)  NULL,
        RowVersion           ROWVERSION     NOT NULL,
        CONSTRAINT PK_DefectsPeriods PRIMARY KEY (DefectsPeriodId),
        CONSTRAINT FK_DefectsPeriods_Buildings FOREIGN KEY (BuildingId)
            REFERENCES dbo.Buildings(BuildingID),
        CONSTRAINT FK_DefectsPeriods_Locations FOREIGN KEY (LocationId)
            REFERENCES dbo.Locations(LocationId),
        CONSTRAINT CK_DefectsPeriods_Scope CHECK (Scope IN (N'building', N'level', N'tenancy')),
        CONSTRAINT CK_DefectsPeriods_Enforcement CHECK (Enforcement IN (N'block', N'warn')),
        CONSTRAINT CK_DefectsPeriods_Dates CHECK (EndsOn >= PracticalCompletion),
        CONSTRAINT CK_DefectsPeriods_Services CHECK (Services = N'all' OR ISJSON(Services) = 1),
        CONSTRAINT CK_DefectsPeriods_ScopeShape CHECK (
            (Scope = N'building' AND LevelName IS NULL AND LocationId IS NULL AND TenantId IS NULL)
            OR (Scope = N'level' AND LevelName IS NOT NULL AND TenantId IS NULL)
            OR (Scope = N'tenancy' AND TenantId IS NOT NULL AND LocationId IS NULL)
        )
    );
END
GO

-- The job write path asks "which live periods cover this building today?".
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DefectsPeriods_Building_Live' AND object_id = OBJECT_ID('dbo.DefectsPeriods'))
    CREATE INDEX IX_DefectsPeriods_Building_Live
        ON dbo.DefectsPeriods (BuildingId, EndsOn)
        INCLUDE (PracticalCompletion, Scope, Enforcement)
        WHERE ArchivedAt IS NULL;
GO

IF OBJECT_ID('dbo.EscalationPolicies', 'U') IS NOT NULL
BEGIN
    MERGE dbo.EscalationPolicies AS target
    USING (VALUES
        (N'defects_period.ends_in_60', N'attention', 0, N'business', N'no', N'[{"role":"facilities_manager"}]', 1),
        (N'defects_period.ends_in_30', N'attention', 0, N'business', N'no', N'[{"role":"facilities_manager"}]', 1)
    ) AS source (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active)
      ON target.PolicyKey = source.PolicyKey
    WHEN NOT MATCHED BY TARGET THEN
      INSERT (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy)
      VALUES (source.PolicyKey, source.Kind, source.Urgent, source.Clock, source.AutoReescalate, source.Ladder, source.Active, N'migration:119_defects_periods');
END
GO
