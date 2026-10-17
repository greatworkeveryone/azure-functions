-- Migration 101: the rent review workflow columns on dbo.RentReviews (WP25, PLAN §3.1).
--
-- A review becomes a workflow instance: it has a state (the ten states of
-- PLAN §3.1), a method, an owner, a snapshot of the lease terms it is decided
-- on (Basis), the figures it works out (Calc), who prepared and approved it,
-- the notice and billing close-out, and a RowVersion for 409s on stale writes.
--
--   Method              cpi | fixed | market | other
--   State               scheduled | due | in_progress | awaiting_index | referred |
--                       awaiting_approval | approved | completed | waived | cancelled
--   StepId              the schedule step the review is linked to (set at commence)
--   BuildingId          the tenancy's building, denormalised for filtering and the ledger
--   OwnerUserId         AppUsers.UserID of whoever commenced it
--   Basis, Calc         JSON (ISJSON checked); Calc is written by WP26
--   Prepared*, SubmittedAt, Approved*, ApprovalBasis, Notice*, BillingConfirmed*,
--   WaiveReason, ExpectedIndexAt   written by WP26 and later; here so the shape is
--                       settled once
--   UpdatedAt           set by the workflow's writes
--   Version             ROWVERSION; a write carries the one it read (409 on a stale write)
--
-- Expand only (database-safety rules 3 and 6). The legacy Status and ReviewType
-- columns and their CHECK constraints from migration 037 stay exactly as they
-- are; every row the workflow writes carries the nearest legacy value
-- (src/rentReview/legacyMap.ts), so the old constraints keep accepting it.
-- Removing them, and mapping the old rows, is a later release's migration 111,
-- separately approved. Existing rows keep State NULL and are not instances: the
-- workflow ignores them. Nothing here changes a row, and the foreign key from
-- migration 037 (a tenancy's reviews go with the tenancy) is untouched.
--
-- One open review per tenancy: a filtered unique index on TenantId over the six
-- open states. Rows with State NULL are outside the filter.
--
-- Idempotent: every column is added only when COL_LENGTH says it is missing, and
-- every constraint and index only when it is not yet there. Each statement sits
-- in its own GO batch, because a batch that adds a column cannot also refer to
-- it. The index needs QUOTED_IDENTIFIER ON; the migration runner and tedious set
-- it, and a hand-run sqlcmd needs -I.

IF COL_LENGTH('dbo.RentReviews', 'Method') IS NULL
  ALTER TABLE dbo.RentReviews ADD Method NVARCHAR(16) NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'State') IS NULL
  ALTER TABLE dbo.RentReviews ADD State NVARCHAR(20) NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'StepId') IS NULL
  ALTER TABLE dbo.RentReviews ADD StepId NVARCHAR(40) NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'BuildingId') IS NULL
  ALTER TABLE dbo.RentReviews ADD BuildingId INT NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'OwnerUserId') IS NULL
  ALTER TABLE dbo.RentReviews ADD OwnerUserId INT NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'Basis') IS NULL
  ALTER TABLE dbo.RentReviews ADD Basis NVARCHAR(MAX) NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'Calc') IS NULL
  ALTER TABLE dbo.RentReviews ADD Calc NVARCHAR(MAX) NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'PreparedById') IS NULL
  ALTER TABLE dbo.RentReviews ADD PreparedById INT NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'PreparedByName') IS NULL
  ALTER TABLE dbo.RentReviews ADD PreparedByName NVARCHAR(200) NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'PreparedAt') IS NULL
  ALTER TABLE dbo.RentReviews ADD PreparedAt DATETIME2 NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'SubmittedAt') IS NULL
  ALTER TABLE dbo.RentReviews ADD SubmittedAt DATETIME2 NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'ApprovedById') IS NULL
  ALTER TABLE dbo.RentReviews ADD ApprovedById INT NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'ApprovedByName') IS NULL
  ALTER TABLE dbo.RentReviews ADD ApprovedByName NVARCHAR(200) NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'ApprovedAt') IS NULL
  ALTER TABLE dbo.RentReviews ADD ApprovedAt DATETIME2 NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'ApprovalBasis') IS NULL
  ALTER TABLE dbo.RentReviews ADD ApprovalBasis NVARCHAR(32) NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'NoticeIssuedAt') IS NULL
  ALTER TABLE dbo.RentReviews ADD NoticeIssuedAt DATETIME2 NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'NoticeIssuedBy') IS NULL
  ALTER TABLE dbo.RentReviews ADD NoticeIssuedBy NVARCHAR(200) NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'NoticeMethod') IS NULL
  ALTER TABLE dbo.RentReviews ADD NoticeMethod NVARCHAR(16) NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'BillingConfirmedAt') IS NULL
  ALTER TABLE dbo.RentReviews ADD BillingConfirmedAt DATETIME2 NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'BillingConfirmedBy') IS NULL
  ALTER TABLE dbo.RentReviews ADD BillingConfirmedBy NVARCHAR(200) NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'WaiveReason') IS NULL
  ALTER TABLE dbo.RentReviews ADD WaiveReason NVARCHAR(2000) NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'ExpectedIndexAt') IS NULL
  ALTER TABLE dbo.RentReviews ADD ExpectedIndexAt DATE NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'UpdatedAt') IS NULL
  ALTER TABLE dbo.RentReviews ADD UpdatedAt DATETIME2 NULL;
GO

IF COL_LENGTH('dbo.RentReviews', 'Version') IS NULL
  ALTER TABLE dbo.RentReviews ADD Version ROWVERSION;
GO

-- Checks on the new columns. Existing rows hold NULL in each, which every check allows.

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_RentReviews_Method' AND parent_object_id = OBJECT_ID('dbo.RentReviews')
)
  ALTER TABLE dbo.RentReviews ADD CONSTRAINT CK_RentReviews_Method
    CHECK (Method IS NULL OR Method IN ('cpi', 'fixed', 'market', 'other'));
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_RentReviews_State' AND parent_object_id = OBJECT_ID('dbo.RentReviews')
)
  ALTER TABLE dbo.RentReviews ADD CONSTRAINT CK_RentReviews_State
    CHECK (State IS NULL OR State IN (
      'scheduled', 'due', 'in_progress', 'awaiting_index', 'referred',
      'awaiting_approval', 'approved', 'completed', 'waived', 'cancelled'
    ));
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_RentReviews_Basis' AND parent_object_id = OBJECT_ID('dbo.RentReviews')
)
  ALTER TABLE dbo.RentReviews ADD CONSTRAINT CK_RentReviews_Basis
    CHECK (Basis IS NULL OR ISJSON(Basis) = 1);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_RentReviews_Calc' AND parent_object_id = OBJECT_ID('dbo.RentReviews')
)
  ALTER TABLE dbo.RentReviews ADD CONSTRAINT CK_RentReviews_Calc
    CHECK (Calc IS NULL OR ISJSON(Calc) = 1);
GO

-- One open review per tenancy. The six states are the ones before approval; an
-- approved, completed, waived or cancelled review falls outside the filter, so
-- a tenancy keeps as many of those as it has had reviews.

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'UX_RentReviews_OpenPerTenant' AND object_id = OBJECT_ID('dbo.RentReviews')
)
  CREATE UNIQUE INDEX UX_RentReviews_OpenPerTenant
    ON dbo.RentReviews (TenantId)
    WHERE State IN ('scheduled', 'due', 'in_progress', 'awaiting_index', 'referred', 'awaiting_approval');
GO
