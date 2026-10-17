-- Migration 139: keys_rowversion (fix/keys-edit-overwrite).
--
-- Editing a key wrote the whole form over the row (tenancy, location, subtype,
-- registration, description, photo, storage location) without checking that
-- the key was still as the editor had read it, so the last save won and the
-- other person's change vanished without a word (database-safety rule 6).
-- This adds the version that check needs:
--
--   Keys.Version   ROWVERSION. The server stamps a new value on every write to
--                  the row, whoever makes it: an edit, a check-out or check-in
--                  that moves the storage location, report lost, archive,
--                  restore. getKeys, getKeyDetail, createKey and updateKey
--                  return it as 16 hex characters (rowVersion); updateKey must
--                  send it back, reads the row under an update lock, and a
--                  mismatch is a 409 that carries the current key.
--
-- Same pattern as Tenants.RowVersion (096) and RentReviews.Version (101).
--
-- Additive and re-runnable: the column is added only when missing, in a batch
-- of its own, and the server gives every existing row its first value, so no
-- default is needed and no row is rewritten by us. Nothing is dropped,
-- narrowed, renamed or updated. A table can hold one ROWVERSION; dbo.Keys has
-- none (030, 047, 048).
--
-- RUNBOOK: apply 139 before the build that serves getKeys, getKeyDetail,
-- createKey and updateKey with k.Version, or the keys list fails on an unknown
-- column name.

IF COL_LENGTH('dbo.Keys', 'Version') IS NULL
  ALTER TABLE dbo.Keys ADD Version ROWVERSION;
GO
