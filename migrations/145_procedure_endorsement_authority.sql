-- Decisions 24/26: configurable endorsement authority; existing procedures use their team manager.
IF COL_LENGTH('dbo.Procedures', 'EndorsementAuthority') IS NULL
  ALTER TABLE dbo.Procedures ADD EndorsementAuthority NVARCHAR(16) NOT NULL
    CONSTRAINT DF_Procedures_EndorsementAuthority DEFAULT 'team';
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name='CK_Procedures_EndorsementAuthority' AND parent_object_id=OBJECT_ID('dbo.Procedures'))
  ALTER TABLE dbo.Procedures ADD CONSTRAINT CK_Procedures_EndorsementAuthority
    CHECK (EndorsementAuthority IN ('team', 'executive'));
GO
IF OBJECT_ID('dbo.ProcedureEndorsementAudit', 'U') IS NULL
CREATE TABLE dbo.ProcedureEndorsementAudit (
  AuditId BIGINT IDENTITY PRIMARY KEY,
  Slug NVARCHAR(128) NOT NULL,
  PreviousAuthority NVARCHAR(16) NOT NULL,
  Authority NVARCHAR(16) NOT NULL,
  ChangedBy NVARCHAR(255) NOT NULL,
  ChangedAt DATETIME2 NOT NULL CONSTRAINT DF_ProcedureEndorsementAudit_ChangedAt DEFAULT SYSUTCDATETIME()
);
