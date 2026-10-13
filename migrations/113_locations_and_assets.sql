-- Migration 113: Locations spine + asset register (WP49a).
--
-- Tables
--   Locations        stable ids for building -> level -> space (+ nested spaces).
--                    Seeded below from Buildings.Levels and TenantOccupancies.
--   AssetTypes       controlled taxonomy (Category -> Name). Deliberately NOT
--                    seeded: only facilities managers / admins add types, and
--                    the real list comes from mapping the myBuildings export.
--   Assets           the register itself. Floorplan owns identity; Source +
--                    ExternalId record provenance so a myBuildings import
--                    (WP49c) can upsert idempotently.
--   JobAssets        job <-> asset links (many to many).
--   AssetAttachments junction over dbo.Attachments (the TenancyAttachments
--                    pattern, migration 056).
--
-- BuildingId on Locations/Assets references Buildings(BuildingID) - the
-- upstream business key (negative for manual buildings, migration 093) - like
-- every other FK in this schema (see 032/035).
--
-- Numbering: 094-112 belong to the engineering plan. Never renumber.
--
-- Idempotent: every CREATE is guarded and every seed is a MERGE that only
-- inserts. This file is applied by the startup runner (src/migrate.ts), which
-- refuses to boot the app if a batch throws - so the seed batches below are
-- written to survive dirty source data (malformed Levels JSON, blank or
-- over-long names, names that differ only by case/whitespace, occupancies for
-- buildings that no longer exist, OPENJSON's BIN2 collation).

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

-- ── Locations ───────────────────────────────────────────────────────────────
-- Kind 'level' is always top-level and has no SpaceType. A 'space' may sit
-- directly under the building (ParentLocationId NULL: roof, car park, external
-- areas) or under a level / another space. Same-building parents are enforced
-- by upsertLocation. Rows are deactivated (Active = 0), never deleted.

IF OBJECT_ID('dbo.Locations', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Locations (
        LocationId        INT            IDENTITY(1,1) NOT NULL,
        BuildingId        INT            NOT NULL,
        ParentLocationId  INT            NULL,
        Kind              NVARCHAR(10)   NOT NULL,
        Name              NVARCHAR(100)  NOT NULL,
        SpaceType         NVARCHAR(20)   NULL,
        SortOrder         INT            NOT NULL CONSTRAINT DF_Locations_SortOrder DEFAULT 0,
        Active            BIT            NOT NULL CONSTRAINT DF_Locations_Active DEFAULT 1,
        CreatedAt         DATETIME2      NOT NULL CONSTRAINT DF_Locations_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBy         NVARCHAR(200)  NULL,
        UpdatedAt         DATETIME2      NOT NULL CONSTRAINT DF_Locations_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBy         NVARCHAR(200)  NULL,
        CONSTRAINT PK_Locations PRIMARY KEY (LocationId),
        CONSTRAINT FK_Locations_Buildings FOREIGN KEY (BuildingId)
            REFERENCES dbo.Buildings(BuildingID),
        CONSTRAINT FK_Locations_Parent FOREIGN KEY (ParentLocationId)
            REFERENCES dbo.Locations(LocationId),
        CONSTRAINT CK_Locations_Kind CHECK (Kind IN ('level', 'space')),
        CONSTRAINT CK_Locations_SpaceType CHECK (
            SpaceType IS NULL
            OR SpaceType IN ('tenancy', 'common', 'plant', 'roof', 'carpark', 'external', 'residence', 'other')
        ),
        CONSTRAINT CK_Locations_LevelShape CHECK (
            Kind <> 'level' OR (ParentLocationId IS NULL AND SpaceType IS NULL)
        )
    );
END
GO

-- Unique active name per parent. Two filtered indexes rather than one index
-- over ISNULL(ParentLocationId, 0): same rule, no computed column.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Locations_Root_Name' AND object_id = OBJECT_ID('dbo.Locations'))
    CREATE UNIQUE INDEX UX_Locations_Root_Name
        ON dbo.Locations (BuildingId, Name)
        WHERE Active = 1 AND ParentLocationId IS NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Locations_Child_Name' AND object_id = OBJECT_ID('dbo.Locations'))
    CREATE UNIQUE INDEX UX_Locations_Child_Name
        ON dbo.Locations (BuildingId, ParentLocationId, Name)
        WHERE Active = 1 AND ParentLocationId IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Locations_Building' AND object_id = OBJECT_ID('dbo.Locations'))
    CREATE INDEX IX_Locations_Building ON dbo.Locations (BuildingId, ParentLocationId);
GO

-- ── AssetTypes ──────────────────────────────────────────────────────────────
-- Category is one of the maintenance categories (validated in code, like
-- Jobs.Category - the list can grow without a migration).

IF OBJECT_ID('dbo.AssetTypes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.AssetTypes (
        AssetTypeId  INT            IDENTITY(1,1) NOT NULL,
        Category     NVARCHAR(50)   NOT NULL,
        Name         NVARCHAR(100)  NOT NULL,
        Active       BIT            NOT NULL CONSTRAINT DF_AssetTypes_Active DEFAULT 1,
        SortOrder    INT            NOT NULL CONSTRAINT DF_AssetTypes_SortOrder DEFAULT 0,
        CreatedAt    DATETIME2      NOT NULL CONSTRAINT DF_AssetTypes_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBy    NVARCHAR(200)  NULL,
        UpdatedAt    DATETIME2      NOT NULL CONSTRAINT DF_AssetTypes_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBy    NVARCHAR(200)  NULL,
        CONSTRAINT PK_AssetTypes PRIMARY KEY (AssetTypeId)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_AssetTypes_Category_Name' AND object_id = OBJECT_ID('dbo.AssetTypes'))
    CREATE UNIQUE INDEX UX_AssetTypes_Category_Name
        ON dbo.AssetTypes (Category, Name)
        WHERE Active = 1;
GO

-- ── Assets ──────────────────────────────────────────────────────────────────
-- AssetTypeId is the controlled type; AssetTypeNote carries the free text when
-- the type is "Other" or not yet classified (AssetTypeId NULL).
-- Source/ExternalId: provenance. 'mybuildings' rows carry the upstream asset id
-- so re-imports update in place. VerifiedAt/By: a person has confirmed what and
-- where the asset is; upsertAsset clears it when identity fields change.
-- Archived assets stay in the table (job links are history) and release their
-- AssetTag for reuse.

IF OBJECT_ID('dbo.Assets', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Assets (
        AssetId              INT            IDENTITY(1,1) NOT NULL,
        BuildingId           INT            NOT NULL,
        LocationId           INT            NULL,
        ParentAssetId        INT            NULL,
        AssetTag             NVARCHAR(40)   NULL,
        Name                 NVARCHAR(200)  NOT NULL,
        Category             NVARCHAR(50)   NOT NULL,
        AssetTypeId          INT            NULL,
        AssetTypeNote        NVARCHAR(200)  NULL,
        Make                 NVARCHAR(100)  NULL,
        Model                NVARCHAR(100)  NULL,
        SerialNumber         NVARCHAR(100)  NULL,
        InstallDate          DATE           NULL,
        WarrantyExpiry       DATE           NULL,
        Responsibility       NVARCHAR(20)   NOT NULL CONSTRAINT DF_Assets_Responsibility DEFAULT 'owner',
        Status               NVARCHAR(20)   NOT NULL CONSTRAINT DF_Assets_Status DEFAULT 'active',
        Criticality          NVARCHAR(20)   NOT NULL CONSTRAINT DF_Assets_Criticality DEFAULT 'standard',
        ServiceContractorId  INT            NULL,
        Specs                NVARCHAR(MAX)  NULL,
        Notes                NVARCHAR(2000) NULL,
        Source               NVARCHAR(20)   NOT NULL CONSTRAINT DF_Assets_Source DEFAULT 'manual',
        ExternalId           NVARCHAR(50)   NULL,
        VerifiedAt           DATETIME2      NULL,
        VerifiedBy           NVARCHAR(200)  NULL,
        CreatedAt            DATETIME2      NOT NULL CONSTRAINT DF_Assets_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBy            NVARCHAR(200)  NULL,
        UpdatedAt            DATETIME2      NOT NULL CONSTRAINT DF_Assets_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBy            NVARCHAR(200)  NULL,
        ArchivedAt           DATETIME2      NULL,
        ArchivedBy           NVARCHAR(200)  NULL,
        CONSTRAINT PK_Assets PRIMARY KEY (AssetId),
        CONSTRAINT FK_Assets_Buildings FOREIGN KEY (BuildingId)
            REFERENCES dbo.Buildings(BuildingID),
        CONSTRAINT FK_Assets_Locations FOREIGN KEY (LocationId)
            REFERENCES dbo.Locations(LocationId),
        CONSTRAINT FK_Assets_Parent FOREIGN KEY (ParentAssetId)
            REFERENCES dbo.Assets(AssetId),
        CONSTRAINT FK_Assets_AssetTypes FOREIGN KEY (AssetTypeId)
            REFERENCES dbo.AssetTypes(AssetTypeId),
        CONSTRAINT CK_Assets_Responsibility CHECK (Responsibility IN ('owner', 'tenant', 'shared')),
        CONSTRAINT CK_Assets_Status CHECK (Status IN ('active', 'out_of_service', 'decommissioned')),
        CONSTRAINT CK_Assets_Criticality CHECK (Criticality IN ('critical', 'standard')),
        CONSTRAINT CK_Assets_Source CHECK (Source IN ('manual', 'mybuildings')),
        CONSTRAINT CK_Assets_Specs_IsJson CHECK (Specs IS NULL OR ISJSON(Specs) = 1)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Assets_Building_Category' AND object_id = OBJECT_ID('dbo.Assets'))
    CREATE INDEX IX_Assets_Building_Category ON dbo.Assets (BuildingId, Category);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Assets_Location' AND object_id = OBJECT_ID('dbo.Assets'))
    CREATE INDEX IX_Assets_Location ON dbo.Assets (LocationId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Assets_Parent' AND object_id = OBJECT_ID('dbo.Assets'))
    CREATE INDEX IX_Assets_Parent ON dbo.Assets (ParentAssetId) WHERE ParentAssetId IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Assets_AssetType' AND object_id = OBJECT_ID('dbo.Assets'))
    CREATE INDEX IX_Assets_AssetType ON dbo.Assets (AssetTypeId) WHERE AssetTypeId IS NOT NULL;
GO

-- AssetTag is unique per building among live assets; archiving frees the tag.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Assets_Building_Tag' AND object_id = OBJECT_ID('dbo.Assets'))
    CREATE UNIQUE INDEX UX_Assets_Building_Tag
        ON dbo.Assets (BuildingId, AssetTag)
        WHERE AssetTag IS NOT NULL AND ArchivedAt IS NULL;
GO

-- One row per upstream asset. Archived rows stay in the index on purpose: an
-- import must find an archived asset rather than create it a second time.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Assets_Source_External' AND object_id = OBJECT_ID('dbo.Assets'))
    CREATE UNIQUE INDEX UX_Assets_Source_External
        ON dbo.Assets (Source, ExternalId)
        WHERE ExternalId IS NOT NULL;
GO

-- ── JobAssets ───────────────────────────────────────────────────────────────
-- Same-building linking is enforced by linkJobAsset (a CHECK cannot span tables).

IF OBJECT_ID('dbo.JobAssets', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.JobAssets (
        JobId     INT            NOT NULL,
        AssetId   INT            NOT NULL,
        LinkedAt  DATETIME2      NOT NULL CONSTRAINT DF_JobAssets_LinkedAt DEFAULT SYSUTCDATETIME(),
        LinkedBy  NVARCHAR(200)  NULL,
        CONSTRAINT PK_JobAssets PRIMARY KEY (JobId, AssetId),
        CONSTRAINT FK_JobAssets_Jobs FOREIGN KEY (JobId)
            REFERENCES dbo.Jobs(JobID) ON DELETE CASCADE,
        CONSTRAINT FK_JobAssets_Assets FOREIGN KEY (AssetId)
            REFERENCES dbo.Assets(AssetId) ON DELETE CASCADE
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_JobAssets_AssetId' AND object_id = OBJECT_ID('dbo.JobAssets'))
    CREATE INDEX IX_JobAssets_AssetId ON dbo.JobAssets (AssetId);
GO

-- ── AssetAttachments ────────────────────────────────────────────────────────
-- Deleting an Attachment or an Asset removes the join row only; the cleanup
-- timer never reaps asset blobs (they are not work-request attachments).

IF OBJECT_ID('dbo.AssetAttachments', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.AssetAttachments (
        AssetId       INT            NOT NULL,
        AttachmentID  INT            NOT NULL,
        AttachedBy    NVARCHAR(200)  NULL,
        AttachedAt    DATETIME2      NOT NULL CONSTRAINT DF_AssetAttachments_AttachedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_AssetAttachments PRIMARY KEY (AssetId, AttachmentID),
        CONSTRAINT FK_AssetAttachments_Assets FOREIGN KEY (AssetId)
            REFERENCES dbo.Assets(AssetId) ON DELETE CASCADE,
        CONSTRAINT FK_AssetAttachments_Attachments FOREIGN KEY (AttachmentID)
            REFERENCES dbo.Attachments(Id) ON DELETE CASCADE
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AssetAttachments_AttachmentID' AND object_id = OBJECT_ID('dbo.AssetAttachments'))
    CREATE INDEX IX_AssetAttachments_AttachmentID ON dbo.AssetAttachments (AttachmentID);
GO

-- ── Seed 1/3: one level per entry in Buildings.Levels ───────────────────────
-- SortOrder = the entry's array index. Only string/number entries of a JSON
-- ARRAY are used; anything else (NULL, '', '[]', an object, bad JSON) yields no
-- rows. OPENJSON returns BIN2-collated text, hence COLLATE DATABASE_DEFAULT
-- before anything is compared with a column. Names are trimmed, cut to 100
-- characters and de-duplicated per building so the unique index cannot fire.
-- A root row with the same name (any kind, any Active) counts as a match, so a
-- level someone deactivated is not resurrected by a manual re-run.

;WITH LevelSrc AS (
    SELECT b.BuildingID AS BuildingId,
           CAST(LEFT(LTRIM(RTRIM(j.[value])), 100) AS NVARCHAR(100)) COLLATE DATABASE_DEFAULT AS Name,
           CAST(j.[key] AS INT) AS Idx
      FROM dbo.Buildings b
     CROSS APPLY OPENJSON(
           CASE WHEN ISJSON(b.Levels) = 1 AND LEFT(LTRIM(b.Levels), 1) = N'['
                THEN b.Levels ELSE N'[]' END
         ) j
     WHERE j.[type] IN (1, 2)
       AND LTRIM(RTRIM(j.[value])) <> N''
), LevelDedup AS (
    SELECT BuildingId, Name, MIN(Idx) AS SortOrder
      FROM LevelSrc
     GROUP BY BuildingId, Name
)
MERGE dbo.Locations AS target
USING LevelDedup AS source
   ON target.BuildingId = source.BuildingId
  AND target.ParentLocationId IS NULL
  AND target.Name = source.Name
WHEN NOT MATCHED BY TARGET THEN
    INSERT (BuildingId, ParentLocationId, Kind, Name, SpaceType, SortOrder, Active, CreatedBy, UpdatedBy)
    VALUES (source.BuildingId, NULL, 'level', source.Name, NULL, source.SortOrder, 1, N'migration:113', N'migration:113');
GO

-- ── Seed 2/3: levels used by tenancy occupancies but missing from Levels ────
-- Appended after the building's existing levels, alphabetically. Occupancies
-- for buildings that are not in dbo.Buildings are skipped (they would violate
-- FK_Locations_Buildings and abort startup).

;WITH OccLevels AS (
    SELECT DISTINCT o.BuildingId,
           CAST(LEFT(LTRIM(RTRIM(o.[Level])), 100) AS NVARCHAR(100)) AS Name
      FROM dbo.TenantOccupancies o
      JOIN dbo.Buildings b ON b.BuildingID = o.BuildingId
     WHERE LTRIM(RTRIM(o.[Level])) <> N''
), MissingLevels AS (
    SELECT ol.BuildingId, ol.Name,
           ROW_NUMBER() OVER (PARTITION BY ol.BuildingId ORDER BY ol.Name) AS Rn
      FROM OccLevels ol
     WHERE NOT EXISTS (
             SELECT 1
               FROM dbo.Locations l
              WHERE l.BuildingId = ol.BuildingId
                AND l.ParentLocationId IS NULL
                AND l.Name = ol.Name
           )
), NumberedLevels AS (
    SELECT m.BuildingId, m.Name,
           ISNULL(
               (SELECT MAX(l.SortOrder) FROM dbo.Locations l
                 WHERE l.BuildingId = m.BuildingId AND l.Kind = 'level'),
               -1
           ) + m.Rn AS SortOrder
      FROM MissingLevels m
)
MERGE dbo.Locations AS target
USING NumberedLevels AS source
   ON target.BuildingId = source.BuildingId
  AND target.ParentLocationId IS NULL
  AND target.Name = source.Name
WHEN NOT MATCHED BY TARGET THEN
    INSERT (BuildingId, ParentLocationId, Kind, Name, SpaceType, SortOrder, Active, CreatedBy, UpdatedBy)
    VALUES (source.BuildingId, NULL, 'level', source.Name, NULL, source.SortOrder, 1, N'migration:113', N'migration:113');
GO

-- ── Seed 3/3: one tenancy space per distinct (building, level, area) ────────
-- Parented to the matching active level (case-insensitive, trimmed).
-- Distinct on the resolved parent, so 'Ground' and 'ground' cannot yield two
-- spaces with the same name under one level.

;WITH OccSpaces AS (
    SELECT DISTINCT o.BuildingId,
           lvl.LocationId AS ParentLocationId,
           CAST(LEFT(LTRIM(RTRIM(o.Area)), 100) AS NVARCHAR(100)) AS Name
      FROM dbo.TenantOccupancies o
      JOIN dbo.Buildings b ON b.BuildingID = o.BuildingId
      JOIN dbo.Locations lvl
        ON lvl.BuildingId = o.BuildingId
       AND lvl.Kind = 'level'
       AND lvl.Active = 1
       AND lvl.Name = CAST(LEFT(LTRIM(RTRIM(o.[Level])), 100) AS NVARCHAR(100))
     WHERE LTRIM(RTRIM(o.Area)) <> N''
)
MERGE dbo.Locations AS target
USING OccSpaces AS source
   ON target.BuildingId = source.BuildingId
  AND target.ParentLocationId = source.ParentLocationId
  AND target.Name = source.Name
WHEN NOT MATCHED BY TARGET THEN
    INSERT (BuildingId, ParentLocationId, Kind, Name, SpaceType, SortOrder, Active, CreatedBy, UpdatedBy)
    VALUES (source.BuildingId, source.ParentLocationId, 'space', source.Name, 'tenancy', 0, 1, N'migration:113', N'migration:113');
GO
