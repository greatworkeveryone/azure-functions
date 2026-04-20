-- Migration 014: Jobs.AwaitingRole + JobEvents.NewAwaitingRole
--
-- AwaitingRole is the handoff axis separate from Status. It tracks which
-- internal team needs to take the next action on a job:
--
--   'facilities' — ops team drives the work (the default for new jobs).
--   'accounts'   — finance team takes over; flipped automatically when a
--                  job is marked complete and moves to Awaiting Approval.
--
-- Status can move independently (jobs can be stalled, awaiting parts, etc.
-- in either role), and the filter bar uses AwaitingRole to let each team
-- see only their queue.
--
-- JobEvents.NewAwaitingRole records role transitions in the activity feed
-- the same way NewStatus records status transitions — application code
-- mirrors it onto Jobs.AwaitingRole when the event is inserted.
--
-- Fully idempotent.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'AwaitingRole')
  ALTER TABLE dbo.Jobs ADD AwaitingRole NVARCHAR(20) NOT NULL CONSTRAINT DF_Jobs_AwaitingRole DEFAULT 'facilities';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Jobs_AwaitingRole' AND object_id = OBJECT_ID('dbo.Jobs'))
  CREATE INDEX IX_Jobs_AwaitingRole ON dbo.Jobs(AwaitingRole);
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.JobEvents') AND name = 'NewAwaitingRole')
  ALTER TABLE dbo.JobEvents ADD NewAwaitingRole NVARCHAR(20) NULL;
GO
