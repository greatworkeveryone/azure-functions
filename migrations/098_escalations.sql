-- Migration 098: dbo.Escalations and dbo.EscalationPolicies (WP20, PLAN §3.7, D4).
--
-- The cross-domain escalation engine: one row per escalation, one row per
-- policy. An escalation wraps a domain subject (a job today; quotes, invoices,
-- rent reviews and the rest as their packages land) and never decides for it.
-- Lifecycle: open -> acknowledged -> resolved; open or acknowledged ->
-- superseded (a new row at the next level, linked by ParentEscalationId);
-- open -> withdrawn. Rows are never removed: they end as resolved, superseded or
-- withdrawn, and every transition is also a row in dbo.DecisionLedger.
--
-- Columns beyond the PLAN's list, all on this new table:
--   LastNotificationAttemptAt  when a send was last tried (retry back-off)
--   LastNotifiedAt             when the targets were last told, by a send that
--                              succeeded; the follow-up rule counts from here
--   LastFollowUpAt             when a follow-up email last restarted the clock
--
-- Additive and re-runnable: every statement sits behind IF OBJECT_ID or IF NOT
-- EXISTS and no existing table is touched. The policies are seeded with MERGE
-- ... WHEN NOT MATCHED THEN INSERT only, so running this again never overwrites
-- a policy an admin has edited. Seeds cover every row of PLAN §3.7 except the
-- quote, invoice and purchase_order policies (WP21), and quote.attribution_*
-- (their adapter waits for the attribution table); those packages seed their own.
--
-- Ladder JSON: an array of entries, in escalation order, each with one of
--   { "role": "<AppUsers.Role>" }      everyone active in that role
--   { "token": "raiser_manager" }      resolved from the raiser's role (PLAN §3.7 rule 2)
--   { "token": "authority_route" }     replaced by the approval-authority route (WP21)
--   { "userTarget": true }             a person named when the escalation is raised
-- and "slaHours" (hours on the policy's clock; absent or null = no SLA at that level).
--
-- AutoReescalate: yes = move up a level when the SLA passes unacknowledged;
-- reminder / nudge = repeat the same level; no = leave it to people.

IF OBJECT_ID('dbo.EscalationPolicies', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.EscalationPolicies (
    PolicyKey       NVARCHAR(64)  NOT NULL,
    Kind            NVARCHAR(16)  NOT NULL,
    Urgent          BIT           NOT NULL CONSTRAINT DF_EscalationPolicies_Urgent DEFAULT 0,
    Clock           NVARCHAR(8)   NOT NULL CONSTRAINT DF_EscalationPolicies_Clock DEFAULT 'business',
    Ladder          NVARCHAR(MAX) NOT NULL,
    AutoReescalate  NVARCHAR(10)  NOT NULL CONSTRAINT DF_EscalationPolicies_AutoReescalate DEFAULT 'yes',
    Active          BIT           NOT NULL CONSTRAINT DF_EscalationPolicies_Active DEFAULT 1,
    UpdatedAt       DATETIME2(3)  NOT NULL CONSTRAINT DF_EscalationPolicies_UpdatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedBy       NVARCHAR(200) NULL,
    CONSTRAINT PK_EscalationPolicies PRIMARY KEY (PolicyKey),
    CONSTRAINT CK_EscalationPolicies_Kind CHECK (Kind IN ('attention', 'authority')),
    CONSTRAINT CK_EscalationPolicies_Clock CHECK (Clock IN ('business', 'wall')),
    CONSTRAINT CK_EscalationPolicies_AutoReescalate CHECK (AutoReescalate IN ('yes', 'reminder', 'nudge', 'no')),
    CONSTRAINT CK_EscalationPolicies_Ladder CHECK (ISJSON(Ladder) = 1)
  );
END
GO

IF OBJECT_ID('dbo.Escalations', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Escalations (
    EscalationId              BIGINT         IDENTITY(1,1) NOT NULL,
    SubjectType               NVARCHAR(32)   NOT NULL,
    SubjectId                 NVARCHAR(64)   NOT NULL,
    BuildingId                INT            NULL,
    Kind                      NVARCHAR(16)   NOT NULL,
    Urgent                    BIT            NOT NULL CONSTRAINT DF_Escalations_Urgent DEFAULT 0,
    PolicyKey                 NVARCHAR(64)   NOT NULL,
    [Level]                   INT            NOT NULL CONSTRAINT DF_Escalations_Level DEFAULT 1,
    TargetRole                NVARCHAR(32)   NULL,
    TargetUserId              INT            NULL,
    RaisedByUserId            INT            NULL,
    RaisedByName              NVARCHAR(200)  NOT NULL,
    RaisedByKind              NVARCHAR(8)    NOT NULL,
    Reason                    NVARCHAR(32)   NULL,
    Note                      NVARCHAR(2000) NULL,
    Summary                   NVARCHAR(400)  NOT NULL,
    Context                   NVARCHAR(MAX)  NULL,
    DueAt                     DATETIME2(3)   NULL,
    Status                    NVARCHAR(16)   NOT NULL CONSTRAINT DF_Escalations_Status DEFAULT 'open',
    AcknowledgedAt            DATETIME2(3)   NULL,
    AcknowledgedByUserId      INT            NULL,
    AcknowledgedByName        NVARCHAR(200)  NULL,
    ResolvedAt                DATETIME2(3)   NULL,
    ResolvedByUserId          INT            NULL,
    ResolvedByName            NVARCHAR(200)  NULL,
    ResolutionCode            NVARCHAR(32)   NULL,
    ResolutionNote            NVARCHAR(2000) NULL,
    ParentEscalationId        BIGINT         NULL,
    NoIndependentTarget       BIT            NOT NULL CONSTRAINT DF_Escalations_NoIndependentTarget DEFAULT 0,
    NotificationState         NVARCHAR(8)    NOT NULL CONSTRAINT DF_Escalations_NotificationState DEFAULT 'none',
    NotificationAttempts      INT            NOT NULL CONSTRAINT DF_Escalations_NotificationAttempts DEFAULT 0,
    LastNotificationError     NVARCHAR(500)  NULL,
    LastNotificationAttemptAt DATETIME2(3)   NULL,
    LastNotifiedAt            DATETIME2(3)   NULL,
    LastFollowUpAt            DATETIME2(3)   NULL,
    CreatedAt                 DATETIME2(3)   NOT NULL CONSTRAINT DF_Escalations_CreatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedAt                 DATETIME2(3)   NOT NULL CONSTRAINT DF_Escalations_UpdatedAt DEFAULT SYSUTCDATETIME(),
    RowVersion                ROWVERSION     NOT NULL,
    CONSTRAINT PK_Escalations PRIMARY KEY CLUSTERED (EscalationId),
    CONSTRAINT FK_Escalations_Parent FOREIGN KEY (ParentEscalationId) REFERENCES dbo.Escalations (EscalationId),
    CONSTRAINT CK_Escalations_Kind CHECK (Kind IN ('attention', 'authority')),
    CONSTRAINT CK_Escalations_Level CHECK ([Level] >= 1),
    CONSTRAINT CK_Escalations_RaisedByKind CHECK (RaisedByKind IN ('user', 'system')),
    CONSTRAINT CK_Escalations_Status CHECK (Status IN ('open', 'acknowledged', 'resolved', 'superseded', 'withdrawn')),
    CONSTRAINT CK_Escalations_NotificationState CHECK (NotificationState IN ('none', 'pending', 'sent', 'failed')),
    CONSTRAINT CK_Escalations_Context CHECK (Context IS NULL OR ISJSON(Context) = 1)
  );
END
GO

-- One live escalation per subject and policy: raising the same thing twice finds
-- the first. Superseded, resolved and withdrawn rows fall outside the filter, so
-- the history of a subject can hold as many as it needs.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Escalations_Live' AND object_id = OBJECT_ID('dbo.Escalations'))
  CREATE UNIQUE INDEX UX_Escalations_Live
    ON dbo.Escalations (SubjectType, SubjectId, PolicyKey)
    WHERE Status IN ('open', 'acknowledged');
GO

-- The inbox: "for me" (role or person, by status), "raised by me", and the
-- sweep's SLA scan (open rows by due moment).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Escalations_Target' AND object_id = OBJECT_ID('dbo.Escalations'))
  CREATE INDEX IX_Escalations_Target
    ON dbo.Escalations (TargetRole, TargetUserId, Status)
    INCLUDE (DueAt, Urgent, CreatedAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Escalations_RaisedBy' AND object_id = OBJECT_ID('dbo.Escalations'))
  CREATE INDEX IX_Escalations_RaisedBy
    ON dbo.Escalations (RaisedByUserId, Status)
    INCLUDE (CreatedAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Escalations_Due' AND object_id = OBJECT_ID('dbo.Escalations'))
  CREATE INDEX IX_Escalations_Due
    ON dbo.Escalations (Status, DueAt);
GO

-- Everything about one subject (the banner on a job), and the latest row per
-- subject and policy (the sweep does not re-raise what a person already closed).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Escalations_Subject' AND object_id = OBJECT_ID('dbo.Escalations'))
  CREATE INDEX IX_Escalations_Subject
    ON dbo.Escalations (SubjectType, SubjectId, PolicyKey)
    INCLUDE (Status, CreatedAt, ResolvedAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Escalations_Parent' AND object_id = OBJECT_ID('dbo.Escalations'))
  CREATE INDEX IX_Escalations_Parent
    ON dbo.Escalations (ParentEscalationId)
    WHERE ParentEscalationId IS NOT NULL;
GO

-- Notifications still to send or retry (a handful of rows at any time).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Escalations_Notification' AND object_id = OBJECT_ID('dbo.Escalations'))
  CREATE INDEX IX_Escalations_Notification
    ON dbo.Escalations (NotificationState, Status)
    WHERE NotificationState IN ('pending', 'failed');
GO

-- Seed. role@hours in PLAN §3.7 is { "role": ..., "slaHours": hours }; hours are
-- business hours on the Darwin clock (8 = one business day) unless Clock is
-- 'wall'. A level without hours has no SLA.
;WITH Seed (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder) AS (
  SELECT * FROM (VALUES
    (N'job.stalled_unacknowledged', N'attention', 0, N'business', N'yes',
      N'[{"role":"facilities_manager","slaHours":16},{"role":"director","slaHours":16}]'),
    (N'job.unassigned', N'attention', 0, N'business', N'yes',
      N'[{"role":"facilities_manager","slaHours":8},{"role":"director","slaHours":16}]'),
    (N'job.manual', N'attention', 0, N'business', N'yes',
      N'[{"token":"raiser_manager","slaHours":8},{"role":"director","slaHours":16}]'),
    (N'job.critical', N'attention', 1, N'wall', N'yes',
      N'[{"role":"facilities_manager","slaHours":2},{"role":"director","slaHours":4}]'),
    (N'job.quote_not_back', N'attention', 0, N'business', N'yes',
      N'[{"role":"facilities_manager","slaHours":16},{"role":"director","slaHours":16}]'),
    (N'job.invoice_waiting', N'attention', 0, N'business', N'yes',
      N'[{"role":"accounts_manager","slaHours":16},{"role":"cfo","slaHours":16},{"role":"director"}]'),
    (N'job.past_due', N'attention', 0, N'business', N'yes',
      N'[{"role":"facilities_manager","slaHours":16},{"role":"director","slaHours":16}]'),
    (N'rent_review.not_commenced', N'attention', 0, N'business', N'yes',
      N'[{"role":"accounts_manager","slaHours":40},{"role":"director","slaHours":40}]'),
    (N'rent_review.overdue', N'attention', 0, N'business', N'yes',
      N'[{"role":"accounts_manager","slaHours":16},{"role":"director","slaHours":40}]'),
    (N'rent_review.approval', N'authority', 0, N'business', N'yes',
      N'[{"role":"accounts_manager","slaHours":16},{"role":"cfo","slaHours":16},{"role":"director"}]'),
    (N'rent_review.market_referral', N'authority', 0, N'business', N'nudge',
      N'[{"role":"director","slaHours":80}]'),
    (N'rent_review.index_late', N'attention', 0, N'business', N'no',
      N'[{"role":"admin"}]'),
    (N'rent_review.closeout', N'attention', 0, N'business', N'no',
      N'[{"role":"accounts_manager","slaHours":80}]'),
    (N'billing.run_approval', N'authority', 0, N'business', N'yes',
      N'[{"role":"accounts_manager","slaHours":8},{"role":"cfo","slaHours":8},{"role":"director"}]'),
    (N'comms.contractor_no_reply', N'attention', 0, N'business', N'yes',
      N'[{"role":"facilities_manager","slaHours":16},{"role":"director","slaHours":16}]'),
    (N'comms.legal_notice_approval', N'authority', 0, N'business', N'reminder',
      N'[{"role":"director","slaHours":16}]'),
    (N'comms.arrears_exhausted', N'authority', 0, N'business', N'nudge',
      N'[{"role":"director","slaHours":40}]'),
    (N'lease.option_deadline', N'attention', 0, N'business', N'yes',
      N'[{"role":"accounts_manager","slaHours":40},{"role":"director"}]'),
    (N'lease.option_lapsed', N'attention', 0, N'business', N'no',
      N'[{"role":"director"}]'),
    (N'lease.renewal', N'authority', 0, N'business', N'nudge',
      N'[{"role":"director","slaHours":80}]'),
    (N'any.manual', N'attention', 0, N'business', N'yes',
      N'[{"token":"raiser_manager","slaHours":8},{"role":"director","slaHours":16}]'),
    (N'system.health', N'attention', 0, N'business', N'no',
      N'[{"role":"admin"}]')
  ) AS v (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder)
)
MERGE dbo.EscalationPolicies AS target
USING Seed AS source
  ON target.PolicyKey = source.PolicyKey
WHEN NOT MATCHED BY TARGET THEN
  INSERT (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, UpdatedBy)
  VALUES (source.PolicyKey, source.Kind, source.Urgent, source.Clock, source.AutoReescalate, source.Ladder, N'migration:098_escalations');
GO
