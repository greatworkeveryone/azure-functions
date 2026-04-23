-- Migration 023: Timesheets
--
-- Stores one row per (user, week). The timesheet entries for all seven days
-- are packed into a JSON column so the schema stays stable as the UI evolves.
-- WeekStartDate is always a Monday (enforced by the application layer).
--
-- Fully idempotent.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Timesheets')
BEGIN
  CREATE TABLE dbo.Timesheets (
    TimesheetID          INT IDENTITY(1,1) PRIMARY KEY,
    UserID               NVARCHAR(255) NOT NULL,
    UserDisplayName      NVARCHAR(255) NOT NULL,
    WeekStartDate        DATE          NOT NULL,
    Role                 NVARCHAR(50)  NOT NULL,   -- 'facilities' | 'accounts'
    Data                 NVARCHAR(MAX) NOT NULL DEFAULT '{}',
    ReadyForApproval     BIT           NOT NULL DEFAULT 0,
    ReadyForApprovalDate DATETIME2     NULL,
    Approved             BIT           NOT NULL DEFAULT 0,
    ApprovedDate         DATETIME2     NULL,
    ApprovedBy           NVARCHAR(255) NULL,
    ApprovedByName       NVARCHAR(255) NULL,
    SentToMyobDate       DATETIME2     NULL,
    CreatedOn            DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
    CreatedBy            NVARCHAR(255) NOT NULL,
    UpdatedOn            DATETIME2     NULL,
    UpdatedBy            NVARCHAR(255) NULL,
    CONSTRAINT UQ_Timesheets_User_Week UNIQUE (UserID, WeekStartDate)
  );

  CREATE INDEX IX_Timesheets_UserID       ON dbo.Timesheets(UserID);
  CREATE INDEX IX_Timesheets_WeekStart    ON dbo.Timesheets(WeekStartDate);
  CREATE INDEX IX_Timesheets_Role         ON dbo.Timesheets(Role);
  CREATE INDEX IX_Timesheets_Approval     ON dbo.Timesheets(ReadyForApproval, Approved);
END
GO
