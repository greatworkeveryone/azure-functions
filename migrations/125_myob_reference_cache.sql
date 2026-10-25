-- Migration 125: MYOB mappings the proposal pipeline reads (sprint plan M2,
-- minimal: the CFO's CSV screens and the cache/mirror tables come later and
-- take their own migration).
--
--   dbo.ContractorMyobSupplier  which MYOB supplier card a contractor is, per
--                               company file (UIDs differ between files),
--                               with the supplier's default tax code; matched
--                               by exact ABN or set by hand, always confirmed
--                               by a named person
--   dbo.ChargeCodeAccount       which MYOB account a Floorplan charge code
--                               posts to, per company file, with an optional
--                               tax code that overrides the supplier's
--   dbo.BuildingCompanyFile     which MYOB company file a building belongs to
--
-- A proposal is refused, with a plain reason, when any of these is missing:
-- nothing is guessed. UIDs come from existing Purchase records and the CFO's
-- own MYOB exports, never from Card File or Accounts reads (decision 11).
--
-- Additive and re-runnable: every object is existence-guarded; nothing
-- existing is changed.

IF OBJECT_ID('dbo.ContractorMyobSupplier', 'U') IS NULL
  CREATE TABLE dbo.ContractorMyobSupplier (
    CompanyFileId  NVARCHAR(64)   NOT NULL
                     CONSTRAINT FK_ContractorMyobSupplier_File REFERENCES dbo.MyobCompanyFiles (CompanyFileId),
    ContractorID   INT            NOT NULL,
    SupplierUid    NVARCHAR(64)   NOT NULL,
    SupplierName   NVARCHAR(200)  NOT NULL,
    Abn            NVARCHAR(20)   NULL,
    TaxCodeUid     NVARCHAR(64)   NULL,
    TaxCode        NVARCHAR(10)   NULL,
    MatchBasis     NVARCHAR(8)    NOT NULL CONSTRAINT CK_ContractorMyobSupplier_MatchBasis CHECK (MatchBasis IN (N'abn', N'manual')),
    ConfirmedBy    NVARCHAR(200)  NOT NULL,
    ConfirmedAt    DATETIME2      NOT NULL CONSTRAINT DF_ContractorMyobSupplier_ConfirmedAt DEFAULT SYSUTCDATETIME(),
    Note           NVARCHAR(1000) NULL,
    RowVersion     ROWVERSION     NOT NULL,
    CONSTRAINT PK_ContractorMyobSupplier PRIMARY KEY (CompanyFileId, ContractorID)
  );
GO

IF OBJECT_ID('dbo.ChargeCodeAccount', 'U') IS NULL
  CREATE TABLE dbo.ChargeCodeAccount (
    CompanyFileId     NVARCHAR(64)   NOT NULL
                        CONSTRAINT FK_ChargeCodeAccount_File REFERENCES dbo.MyobCompanyFiles (CompanyFileId),
    ChargeCode        NVARCHAR(4)    NOT NULL,
    AccountUid        NVARCHAR(64)   NOT NULL,
    AccountDisplayId  NVARCHAR(20)   NULL,
    AccountName       NVARCHAR(200)  NULL,
    TaxCodeUid        NVARCHAR(64)   NULL,
    TaxCode           NVARCHAR(10)   NULL,
    ApprovedBy        NVARCHAR(200)  NOT NULL,
    ApprovedAt        DATETIME2      NOT NULL CONSTRAINT DF_ChargeCodeAccount_ApprovedAt DEFAULT SYSUTCDATETIME(),
    Note              NVARCHAR(1000) NULL,
    RowVersion        ROWVERSION     NOT NULL,
    CONSTRAINT PK_ChargeCodeAccount PRIMARY KEY (CompanyFileId, ChargeCode)
  );
GO

IF OBJECT_ID('dbo.BuildingCompanyFile', 'U') IS NULL
  CREATE TABLE dbo.BuildingCompanyFile (
    BuildingID     INT            NOT NULL CONSTRAINT PK_BuildingCompanyFile PRIMARY KEY,
    CompanyFileId  NVARCHAR(64)   NOT NULL
                     CONSTRAINT FK_BuildingCompanyFile_File REFERENCES dbo.MyobCompanyFiles (CompanyFileId),
    MappedBy       NVARCHAR(200)  NOT NULL,
    MappedAt       DATETIME2      NOT NULL CONSTRAINT DF_BuildingCompanyFile_MappedAt DEFAULT SYSUTCDATETIME(),
    Note           NVARCHAR(1000) NULL,
    RowVersion     ROWVERSION     NOT NULL
  );
GO
