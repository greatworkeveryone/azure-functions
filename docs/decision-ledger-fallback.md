# Decision ledger: ledger table or fallback

`migrations/094_decision_ledger.sql` creates `dbo.DecisionLedger` as an Azure SQL
append-only ledger table. If the database refuses that (no ledger support, or the
migrating principal lacks the `ENABLE LEDGER` permission) the migration does not
fail, because a failing migration stops the whole API at startup. It creates the
same table as an ordinary table instead, with an `INSTEAD OF UPDATE, DELETE`
trigger that raises error 51000. `record()`, `getDecisions` and
`getDecisionHistory` behave the same on both; the app does not need to know which
one it got. The fallback table and its trigger are created in one transaction, so
a failure leaves neither behind and the next start tries again.

`dbo.MyobApiLog` (migration 115) uses the same mechanism.

## The fallback is NOT tamper-evident

It blocks accidental and casual changes, including an `UPDATE` or delete run by
`sa` or a `db_owner` member (the trigger fires for them too). It does not stop
someone emptying or removing the table, disabling the trigger, or an
administrator changing data without a trace: there is no hash chain and no
digest to check afterwards. Only the ledger table gives tamper evidence. There
the engine itself refuses any change for every principal, `dbo` included, and
`sys.sp_verify_database_ledger` can prove nothing was altered.

## Which path ran

```sql
SELECT name, ledger_type_desc FROM sys.tables WHERE name = 'DecisionLedger';
-- APPEND_ONLY_LEDGER_TABLE = ledger table
-- NON_LEDGER_TABLE         = fallback
```

The migration also PRINTs which path it took and, for the fallback, why the
ledger table was refused (for example `error 262: ENABLE LEDGER permission
denied`). The migration runner does not log those messages, so use the query.

## If the fallback ran: one manual step

The migration never changes permissions. A database owner runs this once, with
the app's principal (`RP Command Centre`, see `docs/db-access.md`):

```sql
DENY UPDATE, DELETE ON dbo.DecisionLedger TO [<app principal>];
```

The trigger already blocks the change; the `DENY` refuses it earlier, so the app
principal cannot even attempt it. Do not rely on `DENY` against `dbo` or
`db_owner` members: the trigger is the control for them.

## Verification on the fallback

`ledgerVerifyTimer` must not treat the fallback as a failure. With no ledger table
in the database, `sys.sp_verify_database_ledger` fails (error 37392 on an empty
digest list) and `sys.sp_generate_database_ledger_digest` returns a NULL digest.
Check `sys.tables.ledger_type_desc` first and report "not a ledger table
(fallback in use)" for any table that is `NON_LEDGER_TABLE`; verify only the ledger
tables. Verification also needs snapshot isolation enabled on the database (error
37498 otherwise); Azure SQL should have it on, but that has not been checked.

## Moving to a ledger table later

Never in place: an existing table cannot be converted, and no row may be lost or
rewritten. When the database supports ledger tables, in later releases and in this
order:

1. A migration creates a new ledger table under a new name.
2. Copy every row across in batches, preserving `OccurredAt`, and check the row
   counts match.
3. Switch writes and reads (`record()` and the two endpoints) to the new table in
   one release.
4. Keep the old table, read-only, for the audit period; retire it in a later
   release with its own approved migration.
