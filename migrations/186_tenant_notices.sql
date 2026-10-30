-- 186_tenant_notices (TR4, PLAN §15): the status loop. Short notices to the tenant when a job raised from their
-- request is booked or completed.
--
--   dbo.TenantNotices   one row per (job, event): the outbox and the idempotency key in one. A job transition on a
--                       tenant-linked job inserts a 'pending' row inside its own transaction (only while
--                       TENANT_NOTICES_ENABLED is on); the notices sweep sends it through the comms core and
--                       marks it. The unique index on (JobId, Event) is what makes "never twice" true, retries
--                       and a Tenant -> Work bounce included. No foreign keys: the record outlives its job.
--       Event   'attendance' (the job entered Work) or 'completed' (the work was completed).
--       Status  'pending', 'working' (claimed by a sweep), 'sent' (queued through comms), 'dry_run' (would have
--               been sent), 'skipped' (nobody to tell; Detail says why).
--
--   dbo.Procedures / dbo.ProcedureVersions  the request_attendance and request_completed email templates, seeded
--                       once as drafts (insert only). A draft is never sent while sends are live: Facilities
--                       approves the wording in Procedures first.
--
-- Additive and re-runnable: every object behind an existence check. No existing value is rewritten.

IF OBJECT_ID(N'dbo.TenantNotices', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TenantNotices (
    NoticeId        INT           IDENTITY(1,1) NOT NULL CONSTRAINT PK_TenantNotices PRIMARY KEY,
    JobId           INT           NOT NULL,
    WorkRequestId   INT           NULL,
    TenantId        INT           NULL,
    Event           NVARCHAR(16)  NOT NULL,
    Status          NVARCHAR(16)  NOT NULL CONSTRAINT DF_TenantNotices_Status DEFAULT N'pending',
    Detail          NVARCHAR(300) NULL,
    RecipientsText  NVARCHAR(600) NULL,
    CorrespondenceId INT          NULL,
    Attempts        INT           NOT NULL CONSTRAINT DF_TenantNotices_Attempts DEFAULT 0,
    CreatedAt       DATETIME2     NOT NULL CONSTRAINT DF_TenantNotices_CreatedAt DEFAULT SYSUTCDATETIME(),
    ClaimedAt       DATETIME2     NULL,
    ProcessedAt     DATETIME2     NULL,
    CONSTRAINT CK_TenantNotices_Event CHECK (Event IN (N'attendance', N'completed')),
    CONSTRAINT CK_TenantNotices_Status CHECK (Status IN (N'pending', N'working', N'sent', N'dry_run', N'skipped'))
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_TenantNotices_JobEvent' AND object_id = OBJECT_ID('dbo.TenantNotices'))
  CREATE UNIQUE INDEX UX_TenantNotices_JobEvent ON dbo.TenantNotices (JobId, Event);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TenantNotices_Request' AND object_id = OBJECT_ID('dbo.TenantNotices'))
  CREATE INDEX IX_TenantNotices_Request ON dbo.TenantNotices (WorkRequestId) INCLUDE (Event, Status, ProcessedAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TenantNotices_Open' AND object_id = OBJECT_ID('dbo.TenantNotices'))
  CREATE INDEX IX_TenantNotices_Open ON dbo.TenantNotices (Status, NoticeId) INCLUDE (ClaimedAt);
GO

-- The two notice emails: seeded as DRAFTS, once. Insert only, as for request-ack in migration 182. The wording is
-- plain text, never promises a time, and names no link: a personal link cannot be re-sent (only its hash is
-- kept), so the paragraph ending "-link" says where to find it and is left out for an email-only tenancy.
IF NOT EXISTS (SELECT 1 FROM dbo.Procedures WHERE Slug = N'request-attendance')
  INSERT INTO dbo.Procedures (Slug, Category, Audience, SortOrder, Owner)
  VALUES (N'request-attendance', N'Correspondence templates', N'facilities', 21, N'Facilities');
GO

IF NOT EXISTS (SELECT 1 FROM dbo.ProcedureVersions WHERE Slug = N'request-attendance')
  INSERT INTO dbo.ProcedureVersions (Slug, VersionNo, Title, Summary, BlocksJson, Status, CreatedBy)
  VALUES (N'request-attendance', 1, N'Someone is booked to attend: request {{request.reference}}',
    N'Sent once, automatically, when a job raised from a tenant''s request is booked with a contractor. Facilities approves the wording before it goes out.',
    N'[{"id": "request-attendance-0", "kind": "paragraph", "text": "Dear {{tenant.addressee}},"}, {"id": "request-attendance-1", "kind": "paragraph", "text": "A contractor has been booked to attend to {{request.summary}} at {{building.name}}, request {{request.reference}}."}, {"id": "request-attendance-2", "kind": "paragraph", "text": "If access to your suite will be needed, or anything about the problem has changed, please reply to this email."}, {"id": "request-attendance-link", "kind": "paragraph", "text": "You can see where your requests are up to using the personal link we sent you."}]',
    N'draft', N'migration:186_tenant_notices');
GO

IF NOT EXISTS (SELECT 1 FROM dbo.Procedures WHERE Slug = N'request-completed')
  INSERT INTO dbo.Procedures (Slug, Category, Audience, SortOrder, Owner)
  VALUES (N'request-completed', N'Correspondence templates', N'facilities', 22, N'Facilities');
GO

IF NOT EXISTS (SELECT 1 FROM dbo.ProcedureVersions WHERE Slug = N'request-completed')
  INSERT INTO dbo.ProcedureVersions (Slug, VersionNo, Title, Summary, BlocksJson, Status, CreatedBy)
  VALUES (N'request-completed', 1, N'The work is complete: request {{request.reference}}',
    N'Sent once, automatically, when the work on a job raised from a tenant''s request is complete. Facilities approves the wording before it goes out.',
    N'[{"id": "request-completed-0", "kind": "paragraph", "text": "Dear {{tenant.addressee}},"}, {"id": "request-completed-1", "kind": "paragraph", "text": "The work on {{request.summary}} at {{building.name}}, request {{request.reference}}, is now complete."}, {"id": "request-completed-2", "kind": "paragraph", "text": "If the problem is still there, or you have any questions, please reply to this email and we will follow it up."}, {"id": "request-completed-link", "kind": "paragraph", "text": "You can see all your requests using the personal link we sent you."}]',
    N'draft', N'migration:186_tenant_notices');
GO
