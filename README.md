# RPCC Azure Functions

Azure Functions that sync building data from the myBuildings API into Azure SQL Database.

## Functions

### POST /api/syncBuildings
Fetches all buildings from the myBuildings API and upserts them into the Azure SQL `Buildings` table. Handles paging automatically (300 records per page).

### GET /api/getBuildings
Returns buildings from the database. Supports optional query parameters:
- `?buildingId=123` — filter by specific building ID
- `?region=NSW` — filter by region

## Setup

### 1. Prerequisites
- Node.js 22
- Azure Functions Core Tools v4: `npm install -g azure-functions-core-tools@4 --unsafe-perm true`
- VS Code with Azure Functions extension (optional but recommended)

### 2. Install dependencies
```bash
npm install
```

### 3. Configure local.settings.json
Update the values in `local.settings.json`:
- `MYBUILDINGS_API_URL` — the myBuildings base URL
- `MYBUILDINGS_BEARER_TOKEN` — your myBuildings API Bearer token
- `SQL_SERVER` — your Azure SQL server (e.g. `rpcc-server.database.windows.net`)
- `SQL_DATABASE` — your database name

### 4. Create the database table
Run this SQL in the Azure portal Query editor:

```sql
CREATE TABLE Buildings (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    BuildingID INT NULL,
    BuildingName NVARCHAR(255) NULL,
    BuildingCode NVARCHAR(100) NULL,
    BuildingAddress NVARCHAR(500) NULL,
    ThirdPartySystem_BuildingID NVARCHAR(100) NULL,
    Region NVARCHAR(100) NULL,
    NLA NVARCHAR(50) NULL,
    InvoicingAddress NVARCHAR(1000) NULL,
    ContactPhoneNumber NVARCHAR(50) NULL,
    Active BIT DEFAULT 1,
    LastSyncedAt DATETIME2 DEFAULT GETUTCDATE(),
    CreatedAt DATETIME2 DEFAULT GETUTCDATE(),
    UpdatedAt DATETIME2 DEFAULT GETUTCDATE()
);

CREATE UNIQUE INDEX IX_Buildings_BuildingID 
ON Buildings(BuildingID) 
WHERE BuildingID IS NOT NULL;
```

### 5. Grant your Entra ID user SQL access
In the Azure Portal Query editor for your database, run:
```sql
CREATE USER [your-email@domain.com] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [your-email@domain.com];
ALTER ROLE db_datawriter ADD MEMBER [your-email@domain.com];
```

### 6. Add your IP to Azure SQL firewall
Azure Portal → SQL Server (`rp-cc-sql-server`) → Networking → Add your client IP.
Also enable "Allow Azure services and resources to access this server" (needed for the deployed Function App).

### 7. Build and run locally
```bash
npm run build
npm start
```

To test endpoints locally, get an Entra ID token via Azure CLI:
```bash
az login
TOKEN=$(az account get-access-token --resource https://database.windows.net/ --query accessToken -o tsv)
curl -H "Authorization: Bearer $TOKEN" http://localhost:7071/api/getBuildings
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:7071/api/syncBuildings
```

### 8. Deploy to Azure
1. Run `npm run build`
2. In VS Code → Azure panel → right-click **rpcc-functions** → **Deploy to Function App...**

All functions deploy together as a single app. To add a new function, create a file in `src/functions/`, register it with `app.http()`, build, and redeploy.

### 9. Set environment variables in Azure
In Azure Portal → Function App → Configuration → Application settings. Add:
- `MYBUILDINGS_API_URL`
- `MYBUILDINGS_BEARER_TOKEN`
- `SQL_SERVER`
- `SQL_DATABASE`

These are NOT deployed from `local.settings.json` — that file is local only.

### 10. Enable Entra ID authentication (Easy Auth)
After deploying and confirming the functions work:

1. Azure Portal → Function App → **Authentication** → **Add identity provider** → **Microsoft**
2. **Workforce configuration** (current tenant)
3. **App registration type** → Pick existing → select **RP Command Centre**
4. **Client secret expiration** → pick the longest option (e.g. 24 months)
5. **Supported account types** → Current tenant - Single tenant
6. **Client application requirement** → Allow requests only from this application itself
7. **Restrict access** → Require authentication
8. **Unauthenticated requests** → HTTP 401 Unauthorized
9. **Token store** → enabled
10. Click **Add**

This protects all endpoints at the platform level — unauthenticated requests are rejected before your code runs. The `authLevel: "anonymous"` in code is correct; it means no function key is required (Entra ID handles auth instead).

> **Maintenance:** The client secret expires after the chosen period. When it does, auth stops working. Azure sends email warnings before expiry. To rotate: Azure Portal → App registrations → RP Command Centre → Certificates & secrets → generate new secret → update the Function App authentication settings.

## Notes
- **myBuildings staging** uses a self-signed SSL cert. For local dev, `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in `local.settings.json`. Do NOT set this in production — only needed if the staging cert is still self-signed.
- **Tokens expire** after ~1 hour. If you get connection timeouts locally, get a fresh token with `az account get-access-token`.
- **Azure Functions Core Tools** is a devDependency — use `npx func start` rather than installing globally.
- The Function App is on the **Consumption plan** (Linux). To upgrade to Flex Consumption (VNet, warm instances), you need a paid subscription and must create a new Function App and redeploy.

## How it works

1. React app authenticates user via MSAL (Entra ID)
2. React app acquires a token scoped to `https://database.windows.net/user_impersonation`
3. React app calls the Azure Function with that token in the Authorization header
4. Azure Function uses the user's token to connect to Azure SQL (permissions enforced per user)
5. For sync: Function also calls myBuildings API with the stored Bearer token to fetch data
6. Data is upserted into the Buildings table

## Auth flow

```
User → MSAL login → React App → Azure Function → Azure SQL (user's token)
                                       ↓
                              myBuildings API (static Bearer token)
```
