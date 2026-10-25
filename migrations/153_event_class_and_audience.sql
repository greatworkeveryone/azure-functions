-- DESTRUCTIVE: Backfill only the new class/audience/type columns to preserve existing event visibility under Connor's requested Events structure; no old values or rows removed · approved by Connor Randazzo 2026-10-19
-- Events share a coordination record; class, incident type, authority and audience are separate.
IF COL_LENGTH('dbo.MajorEvents','EventClass') IS NULL
  ALTER TABLE dbo.MajorEvents ADD EventClass VARCHAR(16) NOT NULL CONSTRAINT DF_MajorEvents_Class DEFAULT 'major'
    CONSTRAINT CK_MajorEvents_Class CHECK (EventClass IN ('minor','major','project'));
IF COL_LENGTH('dbo.MajorEvents','Audience') IS NULL
BEGIN
  ALTER TABLE dbo.MajorEvents ADD Audience VARCHAR(24) NOT NULL CONSTRAINT DF_MajorEvents_Audience DEFAULT 'managers'
    CONSTRAINT CK_MajorEvents_Audience CHECK (Audience IN ('managers','accounts_managers','accounts_team','operational_staff'));
  EXEC(N'UPDATE dbo.MajorEvents SET Audience=CASE WHEN Domain=''financial'' THEN ''managers'' ELSE ''operational_staff'' END');
END;
IF COL_LENGTH('dbo.MajorEvents','EventKind') IS NULL
BEGIN
  ALTER TABLE dbo.MajorEvents ADD EventKind VARCHAR(32) NULL;
  EXEC(N'UPDATE dbo.MajorEvents SET EventKind=EventType');
END;
