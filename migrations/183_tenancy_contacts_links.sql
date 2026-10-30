-- 183: tenancy contacts and personal links (TR2, PLAN §15). Additive and idempotent.
--
--   TenancyContacts  the people at a tenancy, with roles (reports issues, authorised for costs,
--                    escalation). Archived, never deleted (ArchivedAt/ArchivedBy). RowVersion for 409s.
--   TenantLinks      one personal link per issue: ONLY the SHA-256 of the token is stored. A link
--                    works once ActivatedAt is set (the email carrying it was accepted) and until
--                    RevokedAt or ExpiresAt. Rows are kept for the audit trail.
--   Tenants.EmailOnly  agencies whose IT blocks links: never issued one.
--
-- RUNBOOK: apply before turning on the tenantLinks flag. Nothing here changes existing values:
-- the seed only INSERTs a contact from a tenancy's primary contact fields where that tenancy has
-- never had a contact.

IF COL_LENGTH('dbo.Tenants', 'EmailOnly') IS NULL
  ALTER TABLE dbo.Tenants ADD EmailOnly BIT NOT NULL CONSTRAINT DF_Tenants_EmailOnly DEFAULT 0;
GO

IF OBJECT_ID('dbo.TenancyContacts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.TenancyContacts (
    ContactId          INT           IDENTITY(1,1) NOT NULL CONSTRAINT PK_TenancyContacts PRIMARY KEY,
    TenantId           INT           NOT NULL CONSTRAINT FK_TenancyContacts_Tenants REFERENCES dbo.Tenants (TenantId),
    Name               NVARCHAR(200) NOT NULL,
    Email              NVARCHAR(255) NULL,
    Phone              NVARCHAR(50)  NULL,
    ReportsIssues      BIT           NOT NULL CONSTRAINT DF_TenancyContacts_Reports DEFAULT 0,
    AuthorisedForCosts BIT           NOT NULL CONSTRAINT DF_TenancyContacts_Costs DEFAULT 0,
    IsEscalation       BIT           NOT NULL CONSTRAINT DF_TenancyContacts_Escalation DEFAULT 0,
    SeededFromPrimary  BIT           NOT NULL CONSTRAINT DF_TenancyContacts_Seeded DEFAULT 0,
    CreatedAt          DATETIME2     NOT NULL CONSTRAINT DF_TenancyContacts_CreatedAt DEFAULT SYSUTCDATETIME(),
    CreatedBy          NVARCHAR(200) NULL,
    UpdatedAt          DATETIME2     NOT NULL CONSTRAINT DF_TenancyContacts_UpdatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedBy          NVARCHAR(200) NULL,
    ArchivedAt         DATETIME2     NULL,
    ArchivedBy         NVARCHAR(200) NULL,
    RowVersion         ROWVERSION    NOT NULL
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TenancyContacts_TenantId' AND object_id = OBJECT_ID('dbo.TenancyContacts'))
  CREATE INDEX IX_TenancyContacts_TenantId ON dbo.TenancyContacts (TenantId) INCLUDE (ArchivedAt);
GO

IF OBJECT_ID('dbo.TenantLinks', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.TenantLinks (
    LinkId        INT           IDENTITY(1,1) NOT NULL CONSTRAINT PK_TenantLinks PRIMARY KEY,
    ContactId     INT           NOT NULL CONSTRAINT FK_TenantLinks_Contacts REFERENCES dbo.TenancyContacts (ContactId),
    TenantId      INT           NOT NULL,
    TokenHash     BINARY(32)    NOT NULL,
    IssuedAt      DATETIME2     NOT NULL CONSTRAINT DF_TenantLinks_IssuedAt DEFAULT SYSUTCDATETIME(),
    IssuedBy      NVARCHAR(200) NULL,
    ExpiresAt     DATETIME2     NOT NULL,
    ActivatedAt   DATETIME2     NULL,
    RevokedAt     DATETIME2     NULL,
    RevokedBy     NVARCHAR(200) NULL,
    RevokeReason  NVARCHAR(100) NULL,
    LastUsedAt    DATETIME2     NULL,
    UseCount      INT           NOT NULL CONSTRAINT DF_TenantLinks_UseCount DEFAULT 0,
    RowVersion    ROWVERSION    NOT NULL
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_TenantLinks_TokenHash' AND object_id = OBJECT_ID('dbo.TenantLinks'))
  CREATE UNIQUE INDEX UX_TenantLinks_TokenHash ON dbo.TenantLinks (TokenHash);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TenantLinks_Contact' AND object_id = OBJECT_ID('dbo.TenantLinks'))
  CREATE INDEX IX_TenantLinks_Contact ON dbo.TenantLinks (ContactId, IssuedAt DESC);
GO

-- Seed: one contact per tenancy from its primary contact fields, only where the tenancy has
-- never had a contact (archived ones count), so running this twice adds nothing.
INSERT INTO dbo.TenancyContacts (TenantId, Name, Email, Phone, ReportsIssues, SeededFromPrimary, CreatedBy, UpdatedBy)
SELECT t.TenantId, LTRIM(RTRIM(t.PrimaryContactName)), NULLIF(LTRIM(RTRIM(t.PrimaryContactEmail)), N''),
       NULLIF(LTRIM(RTRIM(t.PrimaryContactPhone)), N''), 1, 1, N'migration 183', N'migration 183'
  FROM dbo.Tenants t
 WHERE NULLIF(LTRIM(RTRIM(t.PrimaryContactName)), N'') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM dbo.TenancyContacts c WHERE c.TenantId = t.TenantId);
GO
