-- Migration 066: AppUsers
-- Internal staff directory. EntraOid maps to the `oid` claim in Azure Entra
-- ID tokens (same value stored as UserID in dbo.Timesheets). Used to assign
-- Planner tasks to specific people via the Graph API.

CREATE TABLE dbo.AppUsers (
    UserID      INT             IDENTITY(1,1) PRIMARY KEY,
    DisplayName NVARCHAR(200)   NOT NULL,
    Email       NVARCHAR(300)   NOT NULL,
    EntraOid    NVARCHAR(255)   NOT NULL,
    Role        NVARCHAR(50)    NULL,       -- 'facilities' | 'accounts' | 'admin'
    IsActive    BIT             NOT NULL CONSTRAINT DF_AppUsers_IsActive DEFAULT 1,
    CreatedAt   DATETIME2       NOT NULL CONSTRAINT DF_AppUsers_CreatedAt DEFAULT SYSUTCDATETIME(),

    CONSTRAINT UQ_AppUsers_Email    UNIQUE (Email),
    CONSTRAINT UQ_AppUsers_EntraOid UNIQUE (EntraOid)
);
