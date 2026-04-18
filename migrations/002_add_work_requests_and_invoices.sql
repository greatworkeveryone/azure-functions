-- Migration 002: Add WRsLastSyncedAt to Buildings, create WorkRequests, Invoices and Contractors tables
-- Requires migration 001 (Buildings table) to have been run first.

-- ── Buildings: add WRsLastSyncedAt column ────────────────────────────────────
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('Buildings') AND name = 'WRsLastSyncedAt'
)
  ALTER TABLE Buildings ADD WRsLastSyncedAt DATETIME2 NULL;
GO

-- ── WorkRequests table ────────────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'WorkRequests')
BEGIN
  CREATE TABLE WorkRequests (
    Id                      INT            IDENTITY(1,1) PRIMARY KEY,
    WorkRequestID           INT            NOT NULL UNIQUE,
    JobCode                 NVARCHAR(100)  NULL,
    BuildingID              INT            NULL,
    BuildingName            NVARCHAR(255)  NULL,
    LevelName               NVARCHAR(255)  NULL,
    TenantName              NVARCHAR(255)  NULL,
    Category                NVARCHAR(255)  NULL,
    Type                    NVARCHAR(255)  NULL,
    SubType                 NVARCHAR(255)  NULL,
    StatusID                INT            NULL,
    Status                  NVARCHAR(100)  NULL,
    Priority                NVARCHAR(100)  NULL,
    Details                 NVARCHAR(MAX)  NULL,
    ExactLocation           NVARCHAR(500)  NULL,
    ContactName             NVARCHAR(255)  NULL,
    ContactPhone            NVARCHAR(100)  NULL,
    ContactEmail            NVARCHAR(255)  NULL,
    AssignedTo              NVARCHAR(255)  NULL,
    TotalCost               DECIMAL(18,2)  NULL,
    CostNotToExceed         DECIMAL(18,2)  NULL,
    WorkBeganDate           NVARCHAR(50)   NULL,
    ExpectedCompletionDate  NVARCHAR(50)   NULL,
    ActualCompletionDate    NVARCHAR(50)   NULL,
    LastModifiedDate        NVARCHAR(50)   NULL,
    WorkNotes               NVARCHAR(MAX)  NULL,
    PersonAffected          NVARCHAR(255)  NULL,
    LastSyncedAt            DATETIME2      NULL,
    CreatedAt               DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedAt               DATETIME2      NOT NULL DEFAULT GETUTCDATE()
  );

  CREATE INDEX IX_WorkRequests_BuildingID ON WorkRequests (BuildingID);
  CREATE INDEX IX_WorkRequests_StatusID   ON WorkRequests (StatusID);
END
GO

-- ── Invoices table ────────────────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Invoices')
BEGIN
  CREATE TABLE Invoices (
    Id              INT            IDENTITY(1,1) PRIMARY KEY,
    InvoiceID       INT            NOT NULL UNIQUE,
    InvoiceNumber   NVARCHAR(100)  NULL,
    WorkRequestID   INT            NULL,
    JobCode         NVARCHAR(100)  NULL,
    BuildingName    NVARCHAR(255)  NULL,
    BuildingID      INT            NULL,
    ContractorName  NVARCHAR(255)  NULL,
    ContractorID    INT            NULL,
    InvoiceAmount   DECIMAL(18,2)  NULL,
    GSTAmount       DECIMAL(18,2)  NULL,
    TotalAmount     DECIMAL(18,2)  NULL,
    InvoiceDate     NVARCHAR(50)   NULL,
    DateApproved    NVARCHAR(50)   NULL,
    StatusID        INT            NULL,
    Status          NVARCHAR(100)  NULL,
    InvoicePDFURL   NVARCHAR(500)  NULL,
    GLAccountCode   NVARCHAR(100)  NULL,
    LastSyncedAt    DATETIME2      NULL,
    CreatedAt       DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedAt       DATETIME2      NOT NULL DEFAULT GETUTCDATE()
  );

  CREATE INDEX IX_Invoices_BuildingID    ON Invoices (BuildingID);
  CREATE INDEX IX_Invoices_WorkRequestID ON Invoices (WorkRequestID);
  CREATE INDEX IX_Invoices_StatusID      ON Invoices (StatusID);
END
GO

-- ── Contractors table ─────────────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Contractors')
BEGIN
  CREATE TABLE Contractors (
    Id                              INT            IDENTITY(1,1) PRIMARY KEY,
    ContractorID                    INT            NOT NULL UNIQUE,
    ThirdPartySystem_ContractorID   NVARCHAR(255)  NULL,
    ContractorName                  NVARCHAR(255)  NULL,
    ContractorComments              NVARCHAR(MAX)  NULL,
    ContractorCategory              NVARCHAR(255)  NULL,
    ABN                             NVARCHAR(50)   NULL,
    Active                          BIT            NOT NULL DEFAULT 1,
    Suspended                       BIT            NOT NULL DEFAULT 0,
    EmailAddress                    NVARCHAR(255)  NULL,
    PhoneNumber                     NVARCHAR(100)  NULL,
    MobileNumber                    NVARCHAR(100)  NULL,
    ContactFirstName                NVARCHAR(255)  NULL,
    ContactLastName                 NVARCHAR(255)  NULL,
    LastSyncedAt                    DATETIME2      NULL,
    CreatedAt                       DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedAt                       DATETIME2      NOT NULL DEFAULT GETUTCDATE()
  );

  CREATE INDEX IX_Contractors_Active   ON Contractors (Active);
  CREATE INDEX IX_Contractors_Category ON Contractors (ContractorCategory);
END
GO
