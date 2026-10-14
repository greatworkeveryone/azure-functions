-- Migration 124: MYOB identity, token protection and the CFO's controls.
--
-- Sprint packages M0, M1 and M9 share this number so it is used once; the
-- handlers for M1 and M9 follow in Train 2.
--
--   dbo.MyobAuth (046) gains the link's identity and encrypted tokens:
--     BusinessId       the company file MYOB said was approved at link time
--     MyobUserUid      MYOB's user uid from the token response
--     MyobUsername     MYOB's username from the token response
--     LinkedByOid      Entra oid of the admin who started the link
--     LinkedByName     their name
--     CompanyFileName  the file's name, when MYOB reports it
--     TokenCiphertext  AES-256-GCM of the access and refresh tokens (MYOB_TOKEN_KEY)
--     TokenKeyVersion  the key version that sealed them (rotation)
--   The plaintext AccessToken / RefreshToken columns stay (NOT NULL, 046); the
--   app writes '' to them from now on and never reads them.
--
--   dbo.MyobAuthStates      single-use OAuth state: SHA-256 of the state, the
--                           admin who started the link, expiry, when consumed
--   dbo.MyobCompanyFiles    one row per company file Floorplan may know about;
--                           Mode off|read|write, default off (decision 14)
--   dbo.MyobControls        one row per operation per company file: Johanne's
--                           switches (decision 7, sprint M1); defaults are off,
--                           dry run, review required, no daily allowance
--   dbo.MyobApproverCredentials  company-file users per approver, if Johanne
--                           chooses them (decision 13d); AES-GCM ciphertext,
--                           revocable, never deleted
--
-- Additive and re-runnable: every object and column is existence-guarded, new
-- columns are NULL, nothing existing is changed or removed.

-- 1. MyobAuth columns.

IF COL_LENGTH('dbo.MyobAuth', 'BusinessId') IS NULL
  ALTER TABLE dbo.MyobAuth ADD BusinessId NVARCHAR(64) NULL;
GO

IF COL_LENGTH('dbo.MyobAuth', 'MyobUserUid') IS NULL
  ALTER TABLE dbo.MyobAuth ADD MyobUserUid NVARCHAR(100) NULL;
GO

IF COL_LENGTH('dbo.MyobAuth', 'MyobUsername') IS NULL
  ALTER TABLE dbo.MyobAuth ADD MyobUsername NVARCHAR(200) NULL;
GO

IF COL_LENGTH('dbo.MyobAuth', 'LinkedByOid') IS NULL
  ALTER TABLE dbo.MyobAuth ADD LinkedByOid NVARCHAR(100) NULL;
GO

IF COL_LENGTH('dbo.MyobAuth', 'LinkedByName') IS NULL
  ALTER TABLE dbo.MyobAuth ADD LinkedByName NVARCHAR(200) NULL;
GO

IF COL_LENGTH('dbo.MyobAuth', 'CompanyFileName') IS NULL
  ALTER TABLE dbo.MyobAuth ADD CompanyFileName NVARCHAR(200) NULL;
GO

IF COL_LENGTH('dbo.MyobAuth', 'TokenCiphertext') IS NULL
  ALTER TABLE dbo.MyobAuth ADD TokenCiphertext NVARCHAR(MAX) NULL;
GO

IF COL_LENGTH('dbo.MyobAuth', 'TokenKeyVersion') IS NULL
  ALTER TABLE dbo.MyobAuth ADD TokenKeyVersion INT NULL;
GO

-- 2. Single-use OAuth state.

IF OBJECT_ID('dbo.MyobAuthStates', 'U') IS NULL
  CREATE TABLE dbo.MyobAuthStates (
    StateHash      CHAR(64)       NOT NULL CONSTRAINT PK_MyobAuthStates PRIMARY KEY,
    StartedByOid   NVARCHAR(100)  NOT NULL,
    StartedByName  NVARCHAR(200)  NOT NULL,
    CreatedAt      DATETIME2      NOT NULL CONSTRAINT DF_MyobAuthStates_CreatedAt DEFAULT SYSUTCDATETIME(),
    ExpiresAt      DATETIME2      NOT NULL,
    ConsumedAt     DATETIME2      NULL
  );
GO

-- 3. Company files: the control spine (decision 14).

IF OBJECT_ID('dbo.MyobCompanyFiles', 'U') IS NULL
  CREATE TABLE dbo.MyobCompanyFiles (
    CompanyFileId    NVARCHAR(64)   NOT NULL CONSTRAINT PK_MyobCompanyFiles PRIMARY KEY,
    Name             NVARCHAR(200)  NULL,
    Uri              NVARCHAR(500)  NULL,
    Mode             NVARCHAR(8)    NOT NULL CONSTRAINT DF_MyobCompanyFiles_Mode DEFAULT N'off'
                       CONSTRAINT CK_MyobCompanyFiles_Mode CHECK (Mode IN (N'off', N'read', N'write')),
    IsDemonstration  BIT            NOT NULL CONSTRAINT DF_MyobCompanyFiles_IsDemonstration DEFAULT 0,
    DiscoveredAt     DATETIME2      NULL,
    RegisteredBy     NVARCHAR(200)  NULL,
    RegisteredAt     DATETIME2      NOT NULL CONSTRAINT DF_MyobCompanyFiles_RegisteredAt DEFAULT SYSUTCDATETIME(),
    Note             NVARCHAR(1000) NULL,
    UpdatedBy        NVARCHAR(200)  NULL,
    UpdatedAt        DATETIME2      NOT NULL CONSTRAINT DF_MyobCompanyFiles_UpdatedAt DEFAULT SYSUTCDATETIME(),
    RowVersion       ROWVERSION     NOT NULL
  );
GO

-- 4. Johanne's switches, one row per operation per file. Updates apply only to
-- records Floorplan created; there is no delete, attach, sales or other-centre
-- operation to switch on (decision 11).

IF OBJECT_ID('dbo.MyobControls', 'U') IS NULL
  CREATE TABLE dbo.MyobControls (
    CompanyFileId  NVARCHAR(64)   NOT NULL
                     CONSTRAINT FK_MyobControls_CompanyFile REFERENCES dbo.MyobCompanyFiles (CompanyFileId),
    Operation      NVARCHAR(32)   NOT NULL
                     CONSTRAINT CK_MyobControls_Operation CHECK (Operation IN (
                       N'quotes.create', N'quotes.update', N'orders.create', N'orders.update',
                       N'bills.create', N'purchases.read', N'lab.enabled')),
    Enabled        BIT            NOT NULL CONSTRAINT DF_MyobControls_Enabled DEFAULT 0,
    DryRun         BIT            NOT NULL CONSTRAINT DF_MyobControls_DryRun DEFAULT 1,
    DailyCap       INT            NOT NULL CONSTRAINT DF_MyobControls_DailyCap DEFAULT 0
                     CONSTRAINT CK_MyobControls_DailyCap CHECK (DailyCap >= 0),
    RequireReview  BIT            NOT NULL CONSTRAINT DF_MyobControls_RequireReview DEFAULT 1,
    PausedAll      BIT            NOT NULL CONSTRAINT DF_MyobControls_PausedAll DEFAULT 0,
    UpdatedBy      NVARCHAR(200)  NULL,
    UpdatedAt      DATETIME2      NOT NULL CONSTRAINT DF_MyobControls_UpdatedAt DEFAULT SYSUTCDATETIME(),
    Note           NVARCHAR(1000) NULL,
    RowVersion     ROWVERSION     NOT NULL,
    CONSTRAINT PK_MyobControls PRIMARY KEY (CompanyFileId, Operation)
  );
GO

-- 5. Per-approver company-file credentials (only if Johanne chooses them).

IF OBJECT_ID('dbo.MyobApproverCredentials', 'U') IS NULL
  CREATE TABLE dbo.MyobApproverCredentials (
    CredentialId   INT            IDENTITY(1,1) NOT NULL CONSTRAINT PK_MyobApproverCredentials PRIMARY KEY,
    UserOid        NVARCHAR(100)  NOT NULL,
    CompanyFileId  NVARCHAR(64)   NOT NULL
                     CONSTRAINT FK_MyobApproverCredentials_CompanyFile REFERENCES dbo.MyobCompanyFiles (CompanyFileId),
    CfUsername     NVARCHAR(200)  NOT NULL,
    Ciphertext     NVARCHAR(MAX)  NOT NULL,
    KeyVersion     INT            NOT NULL,
    CreatedBy      NVARCHAR(200)  NOT NULL,
    CreatedAt      DATETIME2      NOT NULL CONSTRAINT DF_MyobApproverCredentials_CreatedAt DEFAULT SYSUTCDATETIME(),
    RevokedAt      DATETIME2      NULL,
    RevokedBy      NVARCHAR(200)  NULL
  );
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_MyobApproverCredentials_UserFile'
     AND object_id = OBJECT_ID('dbo.MyobApproverCredentials')
)
  CREATE INDEX IX_MyobApproverCredentials_UserFile ON dbo.MyobApproverCredentials (UserOid, CompanyFileId);
GO
