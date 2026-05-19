# Planner Reminders — One-Time Setup

## 1. Create a Microsoft 365 Group

In [Microsoft 365 admin centre](https://admin.microsoft.com):

1. Go to **Teams & groups → Active teams & groups**
2. Click **Add a group**
3. Choose type: **Microsoft 365** (not Security)
4. Name it e.g. "Property Management"
5. Add all team members who should receive reminders

> Security groups do NOT work with Planner. Must be Microsoft 365 type.

---

## 2. Create the Planner Plan

In [Microsoft Planner](https://tasks.office.com):

1. Click **New plan → Create a basic plan from scratch**
2. Name it **"Property Reminders"**
3. Under "Add to a group", select the group you just created
4. Click **Create**

---

## 3. Create Four Buckets

Inside the new plan, add these four buckets (in order):

- `Lease Expiry`
- `Option Deadlines`
- `Rent Reviews`
- `Job Updates`

---

## 4. Get the IDs via Graph Explorer

Go to [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer) and sign in with your M365 account.

**Group ID:**
```
GET https://graph.microsoft.com/v1.0/me/joinedGroups
```
Find your group → copy `id` → this is `PLANNER_GROUP_ID`

**Plan ID:**
```
GET https://graph.microsoft.com/v1.0/groups/{PLANNER_GROUP_ID}/planner/plans
```
Copy `id` → this is `PLANNER_PLAN_ID`

**Bucket IDs:**
```
GET https://graph.microsoft.com/v1.0/planner/plans/{PLANNER_PLAN_ID}/buckets
```
Copy each bucket's `id` and match to the right env var below.

---

## 5. Add Graph API Permissions

In [Entra ID](https://portal.azure.com) → App registrations → find app `57bd4647-b75d-42b6-b6b3-cc5698fbd868`:

1. Go to **API permissions → Add a permission → Microsoft Graph → Application permissions**
2. Add `Tasks.ReadWrite`
3. Add `Group.Read.All`
4. Click **Grant admin consent**

---

## 6. Add Environment Variables

Add to Azure Functions App Settings in the Azure Portal:

| Variable | Value |
|---|---|
| `PLANNER_GROUP_ID` | from step 4 |
| `PLANNER_PLAN_ID` | from step 4 |
| `PLANNER_BUCKET_LEASE_EXPIRY_ID` | from step 4 |
| `PLANNER_BUCKET_OPTION_DEADLINES_ID` | from step 4 |
| `PLANNER_BUCKET_RENT_REVIEWS_ID` | from step 4 |
| `PLANNER_BUCKET_JOB_UPDATES_ID` | from step 4 |
| `APP_BASE_URL` | e.g. `https://command-centre.example.com` |

Also fill in the placeholders in `local.settings.json` for local testing.

---

## 7. Run the DB Migration

Connect to `rp-cc-sql-server.database.windows.net / free-sql-db-4148991` and run:

```
migrations/062_planner_tasks.sql
```

---

## 8. Enable the Timer in Production

In Azure Functions App Settings, remove (or set to `false`):
```
AzureWebJobs.plannerSyncTimer.Disabled
```

The timer is disabled by default in `local.settings.json` to prevent it running locally.

---

## 9. Test

From Azure Portal → Functions → `plannerSyncTimer` → **Run** to trigger manually.

Verify:
- Tasks appear in the "Property Reminders" Planner plan with correct titles, due dates, and bucket assignments
- Team members see tasks in Outlook Tasks pane under **Assigned to me**
- Applying a rent review in Command Centre completes the corresponding Planner task
