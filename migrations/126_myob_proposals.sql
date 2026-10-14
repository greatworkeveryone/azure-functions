-- Migration 126: dbo.MyobProposals, the only way anything is written to MYOB
-- (sprint plan M3, decisions 11-13). Every MYOB write is first a proposal a
-- person made with "Propose to MYOB" (or "Update in MYOB"), then approved and
-- sent by the CFO with "Approve and send to MYOB", then verified by reading
-- the record back. Payload is the exact JSON sent; PayloadHash is what the
-- preview showed; Rendered is the record in the CFO's words.
--
--   State: proposed -> pushed (approved and being sent) -> verified, or
--   exception (MYOB said no, the outcome is unknown, or the read-back differs),
--   or withdrawn; approved is an approval Floorplan's own controls held back.
--   TargetUid: for an update, the Floorplan-created MYOB record it amends.
--   LastReadBackAt, MyobRowVersion, MyobStatus, MyobSnapshot, Discrepancy:
--   kept current by the read-back sync (plan M10).
--
-- Nothing is ever deleted from this table: a mistake is withdrawn, with who
-- and why. Additive and re-runnable: every object is existence-guarded. The
-- filtered unique index is created through EXEC, as in 116 (the table is new,
-- so it can't meet a duplicate).

IF OBJECT_ID('dbo.MyobProposals', 'U') IS NULL
  CREATE TABLE dbo.MyobProposals (
    ProposalId      INT              IDENTITY(1,1) NOT NULL CONSTRAINT PK_MyobProposals PRIMARY KEY,
    Operation       NVARCHAR(32)     NOT NULL CONSTRAINT CK_MyobProposals_Operation CHECK (Operation IN (
                      N'quotes.create', N'orders.create', N'bills.create', N'quotes.update', N'orders.update')),
    SubjectType     NVARCHAR(32)     NOT NULL CONSTRAINT CK_MyobProposals_SubjectType CHECK (SubjectType IN (
                      N'purchase_order', N'quote', N'invoice')),
    SubjectId       INT              NOT NULL,
    JobId           INT              NULL,
    CompanyFileId   NVARCHAR(64)     NOT NULL CONSTRAINT FK_MyobProposals_File REFERENCES dbo.MyobCompanyFiles (CompanyFileId),
    TargetUid       NVARCHAR(64)     NULL,
    Payload         NVARCHAR(MAX)    NOT NULL CONSTRAINT CK_MyobProposals_Payload CHECK (ISJSON(Payload) = 1),
    PayloadHash     CHAR(64)         NOT NULL,
    Rendered        NVARCHAR(MAX)    NOT NULL CONSTRAINT CK_MyobProposals_Rendered CHECK (ISJSON(Rendered) = 1),
    IdempotencyKey  CHAR(64)         NOT NULL,
    State           NVARCHAR(16)     NOT NULL CONSTRAINT DF_MyobProposals_State DEFAULT N'proposed'
                      CONSTRAINT CK_MyobProposals_State CHECK (State IN (
                        N'proposed', N'approved', N'pushed', N'verified', N'exception', N'withdrawn')),
    ProposedBy      NVARCHAR(200)    NOT NULL,
    ProposedByOid   NVARCHAR(100)    NULL,
    ProposedAt      DATETIME2        NOT NULL,
    ReviewedBy      NVARCHAR(200)    NULL,
    ReviewedByOid   NVARCHAR(100)    NULL,
    ReviewedAt      DATETIME2        NULL,
    PushedAt        DATETIME2        NULL,
    MyobUid         NVARCHAR(64)     NULL,
    MyobNumber      NVARCHAR(30)     NULL,
    MyobUrl         NVARCHAR(500)    NULL,
    ReadBack        NVARCHAR(MAX)    NULL CONSTRAINT CK_MyobProposals_ReadBack CHECK (ReadBack IS NULL OR ISJSON(ReadBack) = 1),
    Diff            NVARCHAR(MAX)    NULL CONSTRAINT CK_MyobProposals_Diff CHECK (Diff IS NULL OR ISJSON(Diff) = 1),
    MyobError       NVARCHAR(2000)   NULL,
    CorrelationId   UNIQUEIDENTIFIER NOT NULL,
    WithdrawnBy     NVARCHAR(200)    NULL,
    WithdrawnAt     DATETIME2        NULL,
    WithdrawReason  NVARCHAR(1000)   NULL,
    LastReadBackAt  DATETIME2        NULL,
    MyobRowVersion  NVARCHAR(64)     NULL,
    MyobStatus      NVARCHAR(32)     NULL,
    MyobSnapshot    NVARCHAR(MAX)    NULL CONSTRAINT CK_MyobProposals_Snapshot CHECK (MyobSnapshot IS NULL OR ISJSON(MyobSnapshot) = 1),
    Discrepancy     NVARCHAR(MAX)    NULL CONSTRAINT CK_MyobProposals_Discrepancy CHECK (Discrepancy IS NULL OR ISJSON(Discrepancy) = 1),
    RowVersion      ROWVERSION       NOT NULL
  );
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MyobProposals_Subject' AND object_id = OBJECT_ID('dbo.MyobProposals'))
  CREATE INDEX IX_MyobProposals_Subject ON dbo.MyobProposals (SubjectType, SubjectId, ProposedAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MyobProposals_FileUid' AND object_id = OBJECT_ID('dbo.MyobProposals'))
  CREATE INDEX IX_MyobProposals_FileUid ON dbo.MyobProposals (CompanyFileId, MyobUid);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MyobProposals_State' AND object_id = OBJECT_ID('dbo.MyobProposals'))
  CREATE INDEX IX_MyobProposals_State ON dbo.MyobProposals (State, ProposedAt);
GO

-- One live proposal per subject and operation: a second "Propose" while one is
-- open or being sent is refused by the database as well as by the code.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_MyobProposals_OpenSubject' AND object_id = OBJECT_ID('dbo.MyobProposals'))
  EXEC('CREATE UNIQUE INDEX UX_MyobProposals_OpenSubject ON dbo.MyobProposals (SubjectType, SubjectId, Operation) WHERE State IN (N''proposed'', N''approved'', N''pushed'')');
GO
