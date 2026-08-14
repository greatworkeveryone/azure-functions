-- Migration 088: Procedures — controlled documents with immutable versions.
--
-- Two tables. dbo.Procedures holds what is true of a document forever (slug,
-- audience, owner); dbo.ProcedureVersions holds revisions. A published row is
-- NEVER updated in place — editing creates a new draft. That is what makes
-- "Approved by X on Y" still true a month later.
--
-- Blocks are stored as JSON: read and written whole, never queried into, and
-- a document is a few kilobytes.
--
-- Two filtered unique indexes allow at most one draft and one published
-- version per procedure, and a CHECK refuses any published row without an
-- approver — constraints, not handler logic, because two live versions of an
-- SOP is the one state this system must never reach.

IF OBJECT_ID('dbo.Procedures', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Procedures (
        Slug        NVARCHAR(128) NOT NULL,
        Category    NVARCHAR(128) NOT NULL,
        -- Comma-separated role names, or 'all'. Small and fixed; a join table
        -- would be three more queries for no gain at this size.
        Audience    NVARCHAR(256) NOT NULL CONSTRAINT DF_Procedures_Audience DEFAULT 'all',
        SortOrder   INT           NOT NULL CONSTRAINT DF_Procedures_SortOrder DEFAULT 0,
        Owner       NVARCHAR(256) NULL,
        CreatedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_Procedures_CreatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_Procedures PRIMARY KEY (Slug)
    );
END
GO

IF OBJECT_ID('dbo.ProcedureVersions', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ProcedureVersions (
        VersionId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_ProcedureVersions_Id DEFAULT NEWID(),
        Slug         NVARCHAR(128) NOT NULL,
        VersionNo    INT           NOT NULL,
        Title        NVARCHAR(256) NOT NULL,
        Summary      NVARCHAR(512) NOT NULL CONSTRAINT DF_ProcedureVersions_Summary DEFAULT '',
        BlocksJson   NVARCHAR(MAX) NOT NULL,
        Status       NVARCHAR(16)  NOT NULL,
        CreatedBy    NVARCHAR(256) NOT NULL,
        CreatedAt    DATETIME2(0)  NOT NULL CONSTRAINT DF_ProcedureVersions_CreatedAt DEFAULT SYSUTCDATETIME(),
        ApprovedBy   NVARCHAR(256) NULL,
        ApprovedAt   DATETIME2(0)  NULL,
        PublishedAt  DATETIME2(0)  NULL,
        ReviewDue    DATE          NULL,
        CONSTRAINT PK_ProcedureVersions PRIMARY KEY (VersionId),
        CONSTRAINT FK_ProcedureVersions_Procedures
            FOREIGN KEY (Slug) REFERENCES dbo.Procedures(Slug) ON DELETE CASCADE,
        CONSTRAINT UQ_ProcedureVersions_Slug_No UNIQUE (Slug, VersionNo),
        CONSTRAINT CK_ProcedureVersions_Status
            CHECK (Status IN ('draft', 'published', 'archived')),
        -- An approval without an approver, or vice versa, would render as
        -- approved on the index. Half an approval is worse than none.
        CONSTRAINT CK_ProcedureVersions_Approval
            CHECK ((ApprovedBy IS NULL AND ApprovedAt IS NULL)
                OR (ApprovedBy IS NOT NULL AND ApprovedAt IS NOT NULL)),
        -- Published means approved. Enforced here so a bug in a handler cannot
        -- put an unapproved document into force.
        CONSTRAINT CK_ProcedureVersions_PublishedIsApproved
            CHECK (Status <> 'published' OR ApprovedBy IS NOT NULL)
    );
END
GO

-- At most one draft and one published version per procedure. Filtered unique
-- indexes rather than application logic, because two live versions of an SOP
-- is the one state this system must never reach.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_ProcedureVersions_OneDraft')
    CREATE UNIQUE INDEX UQ_ProcedureVersions_OneDraft
        ON dbo.ProcedureVersions(Slug) WHERE Status = 'draft';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_ProcedureVersions_OnePublished')
    CREATE UNIQUE INDEX UQ_ProcedureVersions_OnePublished
        ON dbo.ProcedureVersions(Slug) WHERE Status = 'published';
GO
