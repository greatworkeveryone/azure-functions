-- Procedure policy writes carry a monotonic version, including A→B→A changes.
IF COL_LENGTH('dbo.Procedures', 'EndorsementVersion') IS NULL
  ALTER TABLE dbo.Procedures ADD EndorsementVersion INT NOT NULL
    CONSTRAINT DF_Procedures_EndorsementVersion DEFAULT 0;
