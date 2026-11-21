-- Migration 199: the escalation policies for the approvals that used to wait in silence, and two job chases
-- (audit fix AF5; LOOP-04 to -07, LOOP-11, JOB-07, JOB-08).
--
-- Seven policies, every one seeded INACTIVE (Active = 0), so nothing starts firing on deploy. The handler or the
-- sweep that would use a policy finds it switched off, logs that once, and carries on as it did before. Turning a
-- policy on is one row, per policy, and takes effect within five minutes on every instance:
--
--   UPDATE dbo.EscalationPolicies SET Active = 1, UpdatedBy = N'<who>' WHERE PolicyKey = N'<policy key>';
--
--   leave.decision              authority  the approvers named on the request (16 business hours), then the CFO
--                                          (16), then a director. Raised when leave is asked for; ended by the
--                                          decision or the requester withdrawing. The requester is told by the
--                                          engine's resolved notice.
--   comms.broadcast_approval    authority  the sender's manager (8 business hours), then a director. Raised when a
--                                          send is held for approval; ended by approval or cancellation.
--   lease.option_approval       authority  accounts manager (16), CFO (16), director. Raised when an option notice
--                                          is recorded (a late one starts at the director); ended by approval or
--                                          rejection. The person who recorded it is never the target.
--   procedure.approval          authority  the director asked (40 business hours), then the directors. Raised when
--                                          approval is requested; ended by publishing, an edit, or asking again.
--   tenancy.schedule_unsigned   attention  accounts manager (40), then the CFO (40), repeated. Raised by the
--                                          escalation sweep (so it also needs ESCALATION_SWEEP_ENABLED) for a
--                                          tenancy whose schedule is unsigned with a review date inside 60 days
--                                          or past; ends when the schedule is signed off.
--   job.approval_waiting        attention  a director (16), reminded. Raised by the sweep for a quote or invoice
--                                          that has waited two business days for a director; ends when it is decided.
--   job.hold_overdue            attention  facilities manager (16), then a director (16). Raised by the sweep for a
--                                          job on hold (Tenant) or flagged stalled whose next-update date has passed.
--
-- The three sweep policies (tenancy.schedule_unsigned, job.approval_waiting, job.hold_overdue) are also bounded by
-- ESCALATION_SWEEP_SINCE: nothing whose clock started before that date is raised.
--
-- Additive and re-runnable: MERGE ... WHEN NOT MATCHED BY TARGET THEN INSERT only, so an admin's edit (a switch
-- turned on included) is never overwritten and nothing existing is touched. Depends on 098's table; waits for it.

IF OBJECT_ID(N'dbo.EscalationPolicies', N'U') IS NOT NULL
BEGIN
  ;WITH Seed (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active) AS (
    SELECT * FROM (VALUES
      (N'leave.decision', N'authority', 0, N'business', N'yes',
        N'[{"userTarget":true,"slaHours":16},{"role":"cfo","slaHours":16},{"role":"director"}]', 0),
      (N'comms.broadcast_approval', N'authority', 0, N'business', N'yes',
        N'[{"token":"raiser_manager","slaHours":8},{"role":"director"}]', 0),
      (N'lease.option_approval', N'authority', 0, N'business', N'yes',
        N'[{"role":"accounts_manager","slaHours":16},{"role":"cfo","slaHours":16},{"role":"director"}]', 0),
      (N'procedure.approval', N'authority', 0, N'business', N'yes',
        N'[{"userTarget":true,"slaHours":40},{"role":"director"}]', 0),
      (N'tenancy.schedule_unsigned', N'attention', 0, N'business', N'reminder',
        N'[{"role":"accounts_manager","slaHours":40},{"role":"cfo","slaHours":40}]', 0),
      (N'job.approval_waiting', N'attention', 0, N'business', N'reminder',
        N'[{"role":"director","slaHours":16}]', 0),
      (N'job.hold_overdue', N'attention', 0, N'business', N'yes',
        N'[{"role":"facilities_manager","slaHours":16},{"role":"director","slaHours":16}]', 0)
    ) AS v (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active)
  )
  MERGE dbo.EscalationPolicies AS target
  USING Seed AS source
    ON target.PolicyKey = source.PolicyKey
  WHEN NOT MATCHED BY TARGET THEN
    INSERT (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy)
    VALUES (source.PolicyKey, source.Kind, source.Urgent, source.Clock, source.AutoReescalate, source.Ladder, source.Active, N'migration:199_approval_and_chase_policies');
END
GO
