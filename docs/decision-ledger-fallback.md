# Decision ledger fallback: no ledger tables

Migration `094_decision_ledger.sql` creates `dbo.DecisionLedger` as an Azure SQL
append-only ledger table (PLAN §3.12). Use this fallback only if Step 0 against
the real database shows ledger tables are refused (an error on `LEDGER = ON`, or
the app's service principal lacks the `ENABLE LEDGER` permission).

**Decide before 094 runs anywhere.** An applied migration is never edited. If the
fallback is needed, replace the `CREATE TABLE` in 094 with the one below before
the migration is merged, and give `dbo.MyobApiLog` (migration 115) the same
treatment so both tables share one mechanism and one verification.

Nothing here has been executed: it is written against SQL Server 2022 semantics.
Run it against a throwaway database and attempt an `UPDATE` and a removal as
both a `db_owner` user and a plain user before relying on it.

## 1. Table: the 094 columns, minus the ledger clause, plus a hash chain

```sql
CREATE TABLE dbo.DecisionLedger (
  -- ... every column and CHECK constraint exactly as in 094, then:
  PrevHash BINARY(32) NULL,       -- RowHash of the row before; NULL only for the first row
  RowHash  BINARY(32) NOT NULL,   -- SHA-256 over PrevHash + this row's canonical text
  CONSTRAINT PK_DecisionLedger PRIMARY KEY CLUSTERED (LedgerId)
);
```

Same four (and two extra) indexes as 094. `OccurredAt` is supplied by the app,
not defaulted, because the hash covers it.

## 2. Make rows unchangeable

```sql
-- The app's service principal (name as in sys.database_principals).
-- ALTER is denied too: it is what disables a trigger or empties the table
-- (TRUNCATE fires no trigger).
DENY UPDATE, DELETE, ALTER ON dbo.DecisionLedger TO [RP Command Centre];
GO
CREATE TRIGGER dbo.TR_DecisionLedger_BlockUpdate ON dbo.DecisionLedger
INSTEAD OF UPDATE
AS
BEGIN
  THROW 51010, 'dbo.DecisionLedger is append-only: rows cannot be changed.', 1;
END
GO
CREATE TRIGGER dbo.TR_DecisionLedger_BlockDelete ON dbo.DecisionLedger
INSTEAD OF DELETE
AS
BEGIN
  THROW 51011, 'dbo.DecisionLedger is append-only: rows cannot be removed.', 1;
END
GO
```

## 3. The hash chain (app-computed, in `record()`)

Inside the caller's transaction, `record()` takes the chain tip under a lock so
two decisions cannot both extend the same row, then inserts the new row:

```sql
SELECT TOP 1 RowHash FROM dbo.DecisionLedger WITH (UPDLOCK, HOLDLOCK) ORDER BY LedgerId DESC;
```

```ts
const canonical = JSON.stringify([
  occurredAtIso, action, subjectType, subjectId, tenantId, jobId, buildingId,
  actorUserId, actorName, actorRole, actorKind, attributedUserId, attributedName,
  attributedRole, reason, before, after, computed, impact?.toFixed(2) ?? null,
  ruleApplied, correlationId, appVersion, isException,
]);
const rowHash = createHash("sha256").update(prevHash ?? Buffer.alloc(0)).update(canonical).digest();
```

Verification (the `ledgerVerifyTimer` replaces its `sp_verify_database_ledger`
call): walk the table in `LedgerId` order, recompute every `RowHash` from the
stored columns, and check each `PrevHash` equals the previous row's `RowHash`.
Any edit, removal or insertion in the middle breaks the chain from that row on.

Record the newest `RowHash` outside the database each time the timer runs (for
example in the report emailed to the CFO). Without an external copy, someone with
full database control could rewrite the whole table and recompute every hash.

## 4. What this does and does not give you

- Stops the app principal and any ordinary user from changing or removing a row.
- Detects tampering by anyone else, provided the latest hash is held elsewhere.
- Does **not** stop a `db_owner` or server admin from disabling a trigger or
  changing permissions first. The ledger table is stronger on exactly this point:
  the engine refuses the statement for everyone, `dbo` included.
