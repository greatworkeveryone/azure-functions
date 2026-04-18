-- Migration 001: Create Buildings table
-- Run this first against a fresh Azure SQL database.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Buildings')
BEGIN
  CREATE TABLE Buildings (
    Id                          INT            IDENTITY(1,1) PRIMARY KEY,
    BuildingID                  INT            NOT NULL UNIQUE,
    BuildingName                NVARCHAR(255)  NULL,
    BuildingCode                NVARCHAR(100)  NULL,
    BuildingAddress             NVARCHAR(500)  NULL,
    ThirdPartySystem_BuildingID NVARCHAR(255)  NULL,
    RegionID                    INT            NULL,
    Region                      NVARCHAR(255)  NULL,
    NLA                         NVARCHAR(100)  NULL,
    InvoicingAddress            NVARCHAR(500)  NULL,
    ContactPhoneNumber          NVARCHAR(100)  NULL,
    Levels                      NVARCHAR(MAX)  NULL,
    Active                      BIT            NOT NULL DEFAULT 1,
    LastModifiedDate            NVARCHAR(50)   NULL,
    WRsLastSyncedAt             DATETIME2      NULL,
    LastSyncedAt                DATETIME2      NULL,
    CreatedAt                   DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedAt                   DATETIME2      NOT NULL DEFAULT GETUTCDATE()
  );

  CREATE INDEX IX_Buildings_Region ON Buildings (Region);
END
GO
