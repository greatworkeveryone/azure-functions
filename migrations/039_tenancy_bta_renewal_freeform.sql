-- 039_tenancy_bta_renewal_freeform.sql
--
-- Two field reshapes on dbo.Tenants:
--
--   1. BusinessTenanciesActApplies (BIT) → BusinessTenanciesAct (NVARCHAR)
--      The field used to carry yes/no semantics. The actual workbook column
--      stores values like "Not Retail" (i.e. the BTA does not apply because
--      the tenancy isn't retail) and other free-form labels, so the boolean
--      shape was lossy. Drops the old column and adds a renamed string one.
--
--   2. RenewalLetterIssueBy (DATE) → RenewalLetterIssueBy (NVARCHAR)
--      Source values are free-form (e.g. "ASAP", "End of Q3", "30/06/2026")
--      not strict ISO dates, so the DATE constraint kept rejecting imports.
--      Loosened to NVARCHAR.
--
-- Sample data only per m037, so the destructive bits (drop column, lose
-- existing values) skip migration of values. Re-runnable.

-- ── BusinessTenanciesActApplies BIT → BusinessTenanciesAct NVARCHAR ─────────

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants')
    AND name = 'BusinessTenanciesActApplies'
)
  ALTER TABLE dbo.Tenants DROP COLUMN BusinessTenanciesActApplies;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants') AND name = 'BusinessTenanciesAct'
)
  ALTER TABLE dbo.Tenants ADD BusinessTenanciesAct NVARCHAR(100) NULL;
GO

-- ── RenewalLetterIssueBy DATE → NVARCHAR ────────────────────────────────────

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants')
    AND name = 'RenewalLetterIssueBy'
    AND system_type_id = TYPE_ID('date')
)
  ALTER TABLE dbo.Tenants DROP COLUMN RenewalLetterIssueBy;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants') AND name = 'RenewalLetterIssueBy'
)
  ALTER TABLE dbo.Tenants ADD RenewalLetterIssueBy NVARCHAR(255) NULL;
GO
