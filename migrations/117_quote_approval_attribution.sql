-- Migration 117: quote_approval_attribution (LAUNCH-READINESS WP43a-2, R2 and R13).
--
-- R2 (Connor, 13 Oct): a plain facilities user may approve a quote up to their
-- own ApprovalLimits row by declaring they discussed it with a manager and
-- naming that manager. Three nullable columns on dbo.Quotes record it:
--
--   ApprovalAttributedToUserID     the named manager (AppUsers.UserID)
--   ApprovalAttributionDeclaredAt  when the officer declared the discussion
--   AttributionAnsweredAt          when the named manager answered the notice
--                                  ("Yes, I agreed" or "I didn't agree")
--
-- PLAN's approval_attribution adapter sweeps the rows with a manager named and
-- no answer yet, so a notice is raised even for approvals made before the
-- adapter existed.
--
-- R13 (Connor, 13 Oct): a purchase order (or an incoming invoice) whose amount
-- rises within a margin of the originally approved amount stays approved, with
-- a rationale and a named manager. Two additive tables:
--
--   dbo.ApprovalFacts    one row per Admin-editable fact beside the approval
--                        limits. Seeded with the defaults Claude took (Connor
--                        and Johanne to confirm): margin 10 percent, cap $1,000.
--                        Seeded with MERGE ... WHEN NOT MATCHED only, so a value
--                        an admin has changed is never overwritten.
--   dbo.MoneyVariances   one row per amount accepted within the margin: who,
--                        whom they named, the approved quote it was measured
--                        against (QuoteID), the original approved amount, before
--                        and after, $ and %, the rationale, and the named
--                        manager's answer. A later check reads the highest
--                        undisputed amount accepted for a record against the
--                        job's CURRENT approved quote, so a send or an invoice
--                        approval after an accepted edit isn't asked again, and a
--                        rise accepted on a quote since deselected covers
--                        nothing. Rows are never removed.
--
-- The four escalation policies of PLAN §3.7 that 098 left to this package:
-- quote.attribution_notice and po.variance_notice (attention, the named manager,
-- digest, never move up on their own) and quote.attribution_disputed and
-- po.variance_disputed (attention, facilities_manager@8 then director@16; the
-- disputer is left out when they are raised).
--
-- Additive and re-runnable: every CREATE and ALTER sits behind an existence
-- check in a batch of its own; the seeds insert only missing rows. Nothing is
-- dropped, narrowed or rewritten.
--
-- RUNBOOK: apply 117 before the build. The quote list does not select the new
-- columns, but without them these fail with a 500: approving, deselecting or
-- resetting a quote (each writes or clears the attribution columns), any PO
-- edit, PO send or invoice approval above the approved quote
-- (dbo.MoneyVariances, dbo.ApprovalFacts), setApprovalFact, and the escalation
-- sweep's attribution step (which then raises system.health).

IF COL_LENGTH('dbo.Quotes', 'ApprovalAttributedToUserID') IS NULL
  ALTER TABLE dbo.Quotes ADD ApprovalAttributedToUserID INT NULL;
GO

IF COL_LENGTH('dbo.Quotes', 'ApprovalAttributionDeclaredAt') IS NULL
  ALTER TABLE dbo.Quotes ADD ApprovalAttributionDeclaredAt DATETIME2(3) NULL;
GO

IF COL_LENGTH('dbo.Quotes', 'AttributionAnsweredAt') IS NULL
  ALTER TABLE dbo.Quotes ADD AttributionAnsweredAt DATETIME2(3) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Quotes_AttributionUnanswered' AND object_id = OBJECT_ID('dbo.Quotes'))
  CREATE INDEX IX_Quotes_AttributionUnanswered ON dbo.Quotes (ApprovalAttributedToUserID)
    WHERE ApprovalAttributedToUserID IS NOT NULL AND AttributionAnsweredAt IS NULL;
GO

IF OBJECT_ID('dbo.ApprovalFacts', 'U') IS NULL
  CREATE TABLE dbo.ApprovalFacts (
    FactKey    NVARCHAR(64)   NOT NULL,
    FactValue  DECIMAL(18, 4) NOT NULL,
    UpdatedAt  DATETIME2(3)   NOT NULL CONSTRAINT DF_ApprovalFacts_UpdatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedBy  NVARCHAR(200)  NULL,
    CONSTRAINT PK_ApprovalFacts PRIMARY KEY (FactKey),
    CONSTRAINT CK_ApprovalFacts_Value CHECK (FactValue >= 0)
  );
GO

IF OBJECT_ID('dbo.ApprovalFacts', 'U') IS NOT NULL
BEGIN
  MERGE dbo.ApprovalFacts AS target
  USING (VALUES
    (N'po_variance_margin_percent', CAST(10 AS DECIMAL(18, 4))),
    (N'po_variance_cap', CAST(1000 AS DECIMAL(18, 4)))
  ) AS source (FactKey, FactValue)
    ON target.FactKey = source.FactKey
  WHEN NOT MATCHED BY TARGET THEN
    INSERT (FactKey, FactValue, UpdatedBy) VALUES (source.FactKey, source.FactValue, N'migration:117_quote_approval_attribution');
END
GO

IF OBJECT_ID('dbo.MoneyVariances', 'U') IS NULL
  CREATE TABLE dbo.MoneyVariances (
    VarianceID           INT IDENTITY(1, 1) NOT NULL,
    SubjectType          NVARCHAR(20)   NOT NULL,
    SubjectID            INT            NOT NULL,
    JobID                INT            NOT NULL,
    OriginalAmount       DECIMAL(18, 2) NOT NULL,
    PreviousAmount       DECIMAL(18, 2) NULL,
    NewAmount            DECIMAL(18, 2) NOT NULL,
    DeltaAmount          DECIMAL(18, 2) NOT NULL,
    DeltaPercent         DECIMAL(9, 2)  NOT NULL,
    Rationale            NVARCHAR(1000) NOT NULL,
    EditorUserID         INT            NULL,
    EditorName           NVARCHAR(200)  NOT NULL,
    AttributedToUserID   INT            NULL,
    AttributedToName     NVARCHAR(200)  NOT NULL,
    DirectorOverride     BIT            NOT NULL CONSTRAINT DF_MoneyVariances_DirectorOverride DEFAULT 0,
    QuoteID              INT            NULL,
    CreatedAt            DATETIME2(3)   NOT NULL CONSTRAINT DF_MoneyVariances_CreatedAt DEFAULT SYSUTCDATETIME(),
    AnsweredAt           DATETIME2(3)   NULL,
    Disputed             BIT            NULL,
    CONSTRAINT PK_MoneyVariances PRIMARY KEY (VarianceID),
    CONSTRAINT CK_MoneyVariances_Subject CHECK (SubjectType IN (N'purchase_order', N'invoice'))
  );
GO

-- A database that ran an earlier draft of 117 has the table without QuoteID.
IF COL_LENGTH('dbo.MoneyVariances', 'QuoteID') IS NULL
  ALTER TABLE dbo.MoneyVariances ADD QuoteID INT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MoneyVariances_Subject' AND object_id = OBJECT_ID('dbo.MoneyVariances'))
  CREATE INDEX IX_MoneyVariances_Subject ON dbo.MoneyVariances (SubjectType, SubjectID) INCLUDE (NewAmount, Disputed, QuoteID);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MoneyVariances_Job' AND object_id = OBJECT_ID('dbo.MoneyVariances'))
  CREATE INDEX IX_MoneyVariances_Job ON dbo.MoneyVariances (JobID) INCLUDE (NewAmount, Disputed, QuoteID);
GO

IF OBJECT_ID('dbo.EscalationPolicies', 'U') IS NOT NULL
BEGIN
  MERGE dbo.EscalationPolicies AS target
  USING (VALUES
    (N'quote.attribution_notice', N'attention', 0, N'business', N'no', N'[{"userTarget":true}]', 1),
    (N'quote.attribution_disputed', N'attention', 0, N'business', N'yes', N'[{"role":"facilities_manager","slaHours":8},{"role":"director","slaHours":16}]', 1),
    (N'po.variance_notice', N'attention', 0, N'business', N'no', N'[{"userTarget":true}]', 1),
    (N'po.variance_disputed', N'attention', 0, N'business', N'yes', N'[{"role":"facilities_manager","slaHours":8},{"role":"director","slaHours":16}]', 1)
  ) AS source (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active)
    ON target.PolicyKey = source.PolicyKey
  WHEN NOT MATCHED BY TARGET THEN
    INSERT (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy)
    VALUES (source.PolicyKey, source.Kind, source.Urgent, source.Clock, source.AutoReescalate, source.Ladder, source.Active, N'migration:117_quote_approval_attribution');
END
GO
