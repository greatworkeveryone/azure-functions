-- Migration 024: JobRequestedContractors
--
-- Adds a table to track contractors that have been requested for a job.
-- This supports the workflow where facilities staff indicate which contractors
-- they want to engage before a PO is raised.
--
-- Fully idempotent.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'JobRequestedContractors')
BEGIN
  CREATE TABLE dbo.JobRequestedContractors (
    ID              INT IDENTITY(1,1) PRIMARY KEY,
    JobID           INT NOT NULL,
    ContractorID    INT NULL,
    ContractorName  NVARCHAR(255) NOT NULL,
    AddedAt         DATETIME2 NOT NULL CONSTRAINT DF_JobRequestedContractors_AddedAt DEFAULT SYSUTCDATETIME(),
    AddedBy         NVARCHAR(200) NULL,
    CONSTRAINT FK_JobRequestedContractors_Jobs FOREIGN KEY (JobID)
      REFERENCES dbo.Jobs(JobID) ON DELETE CASCADE
  );

  CREATE INDEX IX_JobRequestedContractors_JobID ON dbo.JobRequestedContractors(JobID);
END
GO
