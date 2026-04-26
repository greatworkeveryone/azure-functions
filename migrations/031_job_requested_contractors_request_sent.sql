-- Migration 031: JobRequestedContractors.RequestSent
--
-- Adds a boolean flag tracking whether the contractor has been emailed/contacted
-- for a quote. Used by the combined Quotes step in the job modal so users can
-- tick contractors off as they send out requests.
--
-- Fully idempotent.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
   WHERE object_id = OBJECT_ID('dbo.JobRequestedContractors')
     AND name = 'RequestSent'
)
BEGIN
  ALTER TABLE dbo.JobRequestedContractors
    ADD RequestSent BIT NOT NULL
        CONSTRAINT DF_JobRequestedContractors_RequestSent DEFAULT 0;
END
GO
