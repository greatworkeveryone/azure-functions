-- Add IsStalled to JobEvents so stalled toggles are recorded on the activity
-- feed alongside comments, status changes, and expected-date bumps.
--
-- IsStalled semantics on a JobEvent row:
--   NULL  — event does not concern stall state (comment, status change, etc.)
--   1     — event marks the job as stalled
--   0     — event clears the stalled flag
--
-- When IsStalled is set on an event, addJobEvent also mirrors the value onto
-- Jobs.IsStalled so list-view queries stay current without reading the feed.

ALTER TABLE dbo.JobEvents
    ADD IsStalled BIT NULL;
