# Planner Setup — Two-Plan Architecture

Two separate Microsoft Planner plans:
- **Facilities** — stalled jobs, overdue assigned jobs
- **Accounts** — awaiting accounts, director approvals, tenancy deadlines

Each plan has its own M365 group so team members only see relevant tasks.

---

## 1. Create Two Microsoft 365 Groups

In [Microsoft 365 admin centre](https://admin.microsoft.com) → Teams & groups → Active teams & groups → Add a group (type: **Microsoft 365**):

| Group name | Members |
|---|---|
| `Property Facilities` | Facilities team members |
| `Property Accounts` | Accounts team + director |

> Security groups do NOT work with Planner. Must be Microsoft 365 type.

---

## 2. Create Two Planner Plans

In [Microsoft Planner](https://tasks.office.com) → New plan → Create a basic plan:

| Plan name | Link to group |
|---|---|
| `Facilities Tasks` | Property Facilities |
| `Accounts Tasks` | Property Accounts |

---

## 3. Create Buckets

**Facilities Tasks plan** — 1 bucket:
- `Job Updates`

**Accounts Tasks plan** — 6 buckets:
- `Awaiting Accounts`
- `Director Approval`
- `Lease Expiry`
- `Option Deadlines`
- `Rent Reviews`
- `Oncharge Pending`

---

## 4. Get All IDs via Graph Explorer or Azure CLI

**Option A — Graph Explorer:** Sign in at [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer).

**Option B — Azure CLI:**
```bash
az rest --method get \
  --url "https://graph.microsoft.com/v1.0/planner/plans/{PLAN_ID}/buckets" \
  --query "value[].{name:name, id:id}" \
  --output table
```

**Group IDs:**
```
GET https://graph.microsoft.com/v1.0/me/joinedGroups
```
Find each group → copy `id`.

**Plan IDs:**
```
GET https://graph.microsoft.com/v1.0/groups/{GROUP_ID}/planner/plans
```
Run once per group → copy `id`.

**Bucket IDs (both plans):**
```
GET https://graph.microsoft.com/v1.0/planner/plans/{PLAN_ID}/buckets
```
Run once per plan → match bucket names to env vars below.

---

## 5. App Registration Permissions

In [Entra ID](https://portal.azure.com) → App registrations → app `57bd4647-b75d-42b6-b6b3-cc5698fbd868`:

API permissions → Add → Microsoft Graph → Application:
- `Tasks.ReadWrite`
- `Group.Read.All`

Click **Grant admin consent**.

---

## 6. Environment Variables

Add to Azure Functions App Settings:

| Variable | Description |
|---|---|
| `PLANNER_FACILITIES_GROUP_ID` | Property Facilities group ID |
| `PLANNER_FACILITIES_PLAN_ID` | Facilities Tasks plan ID |
| `PLANNER_FACILITIES_BUCKET_JOB_UPDATES_ID` | "Job Updates" bucket ID |
| `PLANNER_ACCOUNTS_GROUP_ID` | Property Accounts group ID |
| `PLANNER_ACCOUNTS_PLAN_ID` | Accounts Tasks plan ID |
| `PLANNER_ACCOUNTS_BUCKET_AWAITING_ID` | "Awaiting Accounts" bucket ID |
| `PLANNER_ACCOUNTS_BUCKET_DIRECTOR_ID` | "Director Approval" bucket ID |
| `PLANNER_ACCOUNTS_BUCKET_LEASE_EXPIRY_ID` | "Lease Expiry" bucket ID |
| `PLANNER_ACCOUNTS_BUCKET_OPTION_DEADLINES_ID` | "Option Deadlines" bucket ID |
| `PLANNER_ACCOUNTS_BUCKET_RENT_REVIEWS_ID` | "Rent Reviews" bucket ID |
| `PLANNER_ACCOUNTS_BUCKET_ONCHARGE_ID` | "Oncharge Pending" bucket ID |
| `APP_BASE_URL` | e.g. `https://command-centre.example.com` |

Also fill in `local.settings.json` for local testing.

---

## 7. Seed AppUsers

Each staff member who will be assigned jobs in Command Centre needs a row in `dbo.AppUsers`. Get their Entra OID from Graph Explorer:

```
GET https://graph.microsoft.com/v1.0/users/{email}
```
Copy the `id` field. Then insert via the admin endpoint:

```bash
POST /api/upsertAppUser
{
  "displayName": "Sarah Mitchell",
  "email": "s.mitchell@randazzoproperties.com.au",
  "entraOid": "<graph-user-id>",
  "role": "facilities"
}
```

Or run directly via `sqlcmd`:

```sql
INSERT INTO dbo.AppUsers (DisplayName, Email, EntraOid, Role)
VALUES ('Sarah Mitchell', 's.mitchell@randazzoproperties.com.au', '<oid>', 'facilities');
```

---

## 8. Run DB Migrations

Connect to `rp-cc-sql-server.database.windows.net / free-sql-db-4148991` and run in order:

```
migrations/066_app_users.sql
migrations/067_jobs_user_stalledat.sql
migrations/068_planner_tasks_plan_type.sql
```

---

## 9. Enable the Timer

In Azure Functions App Settings, remove (or set to `false`):
```
AzureWebJobs.plannerSyncTimer.Disabled
```

---

## 10. Test

From Azure Portal → Functions → `plannerSyncTimer` → **Run** manually.

Verify:
- Stalled jobs appear in Facilities plan "Job Updates" bucket
- Awaiting-accounts jobs appear in Accounts plan "Awaiting Accounts" bucket
- Tenancy tasks appear in Accounts plan buckets
- Toggling on-charge to tenant for a job creates a task in the "Oncharge Pending" bucket (fires immediately from `upsertJob`; nightly timer reconciles missed fires)
- Raising an outgoing invoice for that job marks the Oncharge Pending task complete
- Completing an action in Command Centre marks the corresponding task done
