-- WP55: an assurance record, never an instruction to enable MYOB writes.
IF OBJECT_ID('dbo.FinanceControlsSignoffs', 'U') IS NULL
CREATE TABLE dbo.FinanceControlsSignoffs (
  SignoffId BIGINT IDENTITY PRIMARY KEY,
  PackVersion NVARCHAR(64) NOT NULL,
  ControlsHash CHAR(64) NOT NULL,
  SnapshotJson NVARCHAR(MAX) NOT NULL,
  SignedBy NVARCHAR(255) NOT NULL,
  Note NVARCHAR(2000) NOT NULL,
  SignedAt DATETIME2 NOT NULL CONSTRAINT DF_FinanceControlsSignoff_SignedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT CK_FinanceControlsSignoff_JSON CHECK (ISJSON(SnapshotJson)=1)
);
