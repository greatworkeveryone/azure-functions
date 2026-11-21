-- SECA-02 / D5: granting director, cfo or admin takes a second person. A request waits here until a
-- different director or admin confirms it; until then the person keeps their previous role.
-- Additive and idempotent: one new table, one filtered unique index (one pending request per person).
IF OBJECT_ID(N'dbo.PendingRoleGrants', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PendingRoleGrants (
    GrantID            INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PendingRoleGrants PRIMARY KEY,
    TargetUserID       INT NOT NULL,
    RequestedRole      NVARCHAR(50) NOT NULL,
    PreviousRole       NVARCHAR(50) NULL,
    RequestedByOid     NVARCHAR(255) NOT NULL,
    RequestedByName    NVARCHAR(255) NOT NULL,
    RequestedAt        DATETIME2(0) NOT NULL CONSTRAINT DF_PendingRoleGrants_RequestedAt DEFAULT SYSUTCDATETIME(),
    Status             NVARCHAR(20) NOT NULL CONSTRAINT DF_PendingRoleGrants_Status DEFAULT N'pending',
    DecidedByOid       NVARCHAR(255) NULL,
    DecidedByName      NVARCHAR(255) NULL,
    DecidedAt          DATETIME2(0) NULL,
    CONSTRAINT CK_PendingRoleGrants_Status CHECK (Status IN (N'pending', N'confirmed', N'declined', N'withdrawn', N'superseded'))
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_PendingRoleGrants_OnePending' AND object_id = OBJECT_ID(N'dbo.PendingRoleGrants'))
  EXEC(N'CREATE UNIQUE INDEX UX_PendingRoleGrants_OnePending ON dbo.PendingRoleGrants (TargetUserID) WHERE Status = N''pending''');
GO
