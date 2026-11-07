-- DESTRUCTIVE: add Denmark to Connor Randazzo's expected countries in dbo.AppUsers.AccessProfile · approved by Will McDonald 2026-11-07
--
-- Migration 181: access_profile_connor_denmark (decision 15)
--
-- Every person's access profile defaults to Australia, so Connor's ordinary
-- sign-ins from home were flagged new_country every day. This adds DK to his
-- expected countries. The rest of his profile stays as it is: the Darwin zone
-- and 06:00-20:00 Mon-Sat window (admin requests are exempt from the window
-- anyway; only his money actions are checked against it). If he works Danish
-- hours for good, change timeZone to Europe/Copenhagen in Settings -> Users ->
-- Access profile; that is an admin edit, not a migration.
--
-- It rewrites one JSON column on one row, found by email, so it follows the
-- approved-destructive shape (database-safety rule 3): the profile columns are
-- copied to a dated backup first, once; the change runs in one transaction;
-- a re-run finds DK already present and changes nothing.
--
-- Undo: dbo.AppUsers_bak_20261107 holds every profile as it stood.

SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;

  -- 1. Back up the profile column for everyone, once.
  IF OBJECT_ID('dbo.AppUsers_bak_20261107', 'U') IS NULL
  BEGIN
    SELECT UserID, Email, AccessProfile, SYSUTCDATETIME() AS BackedUpAt
      INTO dbo.AppUsers_bak_20261107
      FROM dbo.AppUsers;
  END;

  -- 2. Connor: role default plus DK where no profile is stored; DK appended where one is.
  UPDATE dbo.AppUsers
     SET AccessProfile = CASE
           WHEN AccessProfile IS NULL THEN
             N'{"timeZone":"Australia/Darwin","hoursStart":"06:00","hoursEnd":"20:00","days":[1,2,3,4,5,6],"countries":["AU","DK"],"callOutAllowed":false}'
           ELSE JSON_MODIFY(AccessProfile, 'append $.countries', N'DK')
         END
   WHERE Email = N'connor@randazzo.properties'
     AND IsActive = 1
     AND (AccessProfile IS NULL
          OR NOT EXISTS (SELECT 1 FROM OPENJSON(AccessProfile, '$.countries') WHERE [value] = N'DK'));

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
