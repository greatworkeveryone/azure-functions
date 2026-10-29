-- 156_escalation_notification_channel — which route an escalation's alert took (WP64, D21).
--
-- dbo.Escalations records how the targets were told (NotificationState and friends).
-- NotificationChannel says by which route: 'email' (the default, and what every
-- existing row did) or 'teams' (a real-time Teams activity alert went to at least one
-- target, so that target got no email). Written by recordNotification in
-- src/escalation/store.ts; the code probes for the column (escalationChannelColumn.ts),
-- so deploying before applying this does not fail.
--
-- Urgency needs no column here: dbo.EscalationPolicies.Urgent and dbo.Escalations.Urgent
-- have existed since 098. Whether an alert is urgent (the row's flag, or level 2 and up)
-- is decided in code (src/escalation/urgentAlert.ts), so no policy is re-seeded and no
-- existing row changes.
--
-- Additive and re-runnable: the column and its check are added only when missing.

IF COL_LENGTH(N'dbo.Escalations', N'NotificationChannel') IS NULL
BEGIN
  ALTER TABLE dbo.Escalations
    ADD NotificationChannel NVARCHAR(16) NOT NULL
      CONSTRAINT DF_Escalations_NotificationChannel DEFAULT N'email';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Escalations_NotificationChannel' AND parent_object_id = OBJECT_ID(N'dbo.Escalations'))
  ALTER TABLE dbo.Escalations
    ADD CONSTRAINT CK_Escalations_NotificationChannel CHECK (NotificationChannel IN (N'email', N'teams'));
GO
