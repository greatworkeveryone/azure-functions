-- Migration 030: Keys, KeyCheckoutBatches, KeyCheckouts
--
-- Keys  : physical keys and access codes registered against a building/tenancy.
-- KeyCheckoutBatches : one batch = one checkout event covering N keys.
-- KeyCheckouts       : one row per key per batch; tracks individual check-in.
--
-- Fully idempotent.

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Keys')
BEGIN
  CREATE TABLE dbo.Keys (
    Id              INT IDENTITY(1,1) PRIMARY KEY,
    BuildingId      INT            NOT NULL REFERENCES dbo.Buildings(Id),
    TenancyId       INT            NULL     REFERENCES dbo.Tenants(TenantID),
    Level           NVARCHAR(50)   NOT NULL,
    KeyNumber       NVARCHAR(50)   NOT NULL,
    -- ItemType: 'key' | 'code'
    ItemType        NVARCHAR(10)   NOT NULL DEFAULT 'key',
    -- SubType: key subtype or code subtype, NULL is valid
    SubType         NVARCHAR(50)   NULL,
    -- Registration: 'standard' | 'registered' — keys only; ignored for codes
    Registration    NVARCHAR(20)   NOT NULL DEFAULT 'standard',
    Description     NVARCHAR(200)  NOT NULL,
    PhotoBlobUrl    NVARCHAR(500)  NULL,
    -- StorageLocation: one of the known office/room constants — keys only
    StorageLocation NVARCHAR(200)  NULL,
    DateAdded       DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
    -- Status: 'active' | 'lost' | 'retired'
    Status          NVARCHAR(20)   NOT NULL DEFAULT 'active',

    CONSTRAINT UQ_Keys_Building_KeyNumber UNIQUE (BuildingId, KeyNumber)
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'KeyCheckoutBatches')
BEGIN
  CREATE TABLE dbo.KeyCheckoutBatches (
    Id                   INT IDENTITY(1,1) PRIMARY KEY,
    -- CheckedOutBy is auto-set from the authenticated user's name
    CheckedOutBy         NVARCHAR(200)  NOT NULL,
    CheckedOutTo         NVARCHAR(200)  NOT NULL,
    CheckedOutAt         DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    -- Default +24h; callers supply up to +7 days
    ExpectedReturnAt     DATETIME2      NOT NULL,
    CheckOutPhotoBlobUrl NVARCHAR(500)  NOT NULL,
    Notes                NVARCHAR(500)  NULL
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'KeyCheckouts')
BEGIN
  CREATE TABLE dbo.KeyCheckouts (
    Id                  INT IDENTITY(1,1) PRIMARY KEY,
    BatchId             INT            NOT NULL REFERENCES dbo.KeyCheckoutBatches(Id),
    KeyId               INT            NOT NULL REFERENCES dbo.Keys(Id),
    CheckedInAt         DATETIME2      NULL,
    -- Shared URL when keys are returned as a group; set individually otherwise
    CheckInPhotoBlobUrl NVARCHAR(500)  NULL
  );
END
GO
