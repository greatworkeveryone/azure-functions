# Private Migration — Runbook (SQL + Frontend + API)

> **Companion plan:** [`SECURITY-HARDENING-PLAN.md`](./SECURITY-HARDENING-PLAN.md)
> covers application-layer hardening (rate limiting, authorization scoping,
> Conditional Access, Key Vault, etc.) — the controls that defend against the
> *abuse* threats this VNet work doesn't address.

**Goal:** Lock the entire stack — **SQL, frontend (SWA), and backend (API)** — so
nothing is reachable from the public internet. Everyone (staff, phones, admins)
reaches the app **only via the office VPN**. Auth still applies on top.

**Status:** Planned, not started. The plan is sequenced so **everything before
the VPN is non-destructive and reversible** — we create private endpoints
alongside the running system (private path becomes *available*, public stays on)
and only flip public access off in the final, optional VPN phase.

---

## How to fact-check this (read this first)

You don't have to trust the commands blindly. Three safety nets:

1. **It's additive and reversible until the final flips.** Every step before
   "disable public access" *creates* a new resource next to the live system.
   Undo = delete it. The frontend cutover is a one-line revert (a GitHub
   variable). Nothing touches the running backend until you choose to.

2. **Each choice maps to an official Microsoft doc** (table below). If a
   command looks wrong, the doc is the source of truth — Azure also simply
   *errors* on invalid input rather than doing something destructive.

3. **Every step has a "verify" command** that proves it worked before moving on,
   and a stated rollback. When we execute, I run the command, show you the
   output, and tell you what "good" looks like — you're checking *results*,
   not memorising syntax.

### Authoritative references
| Decision | Confirm at |
|---|---|
| Consumption (Y1) can't do VNet → must move to Flex | learn.microsoft.com/azure/azure-functions/functions-networking-options |
| Flex Consumption VNet integration | learn.microsoft.com/azure/azure-functions/flex-consumption-how-to (Virtual network integration) |
| Function App inbound private endpoint | learn.microsoft.com/azure/app-service/networking/private-endpoint |
| Static Web Apps private endpoint (Standard tier only) | learn.microsoft.com/azure/static-web-apps/private-endpoint |
| Azure SQL private endpoint / Private Link | learn.microsoft.com/azure/azure-sql/database/private-endpoint-overview |
| Private DNS for private endpoints | learn.microsoft.com/azure/private-link/private-endpoint-dns |
| Deny public network access on SQL | learn.microsoft.com/azure/azure-sql/database/connectivity-settings (Deny public network access) |
| Static Web Apps build-time env vars | learn.microsoft.com/azure/static-web-apps/build-configuration |
| VPN Gateway P2S + Entra auth | learn.microsoft.com/azure/vpn-gateway/point-to-site-entra-gateway |
| Pricing (sanity-check the cost table) | azure.microsoft.com/pricing/calculator |

---

## Current state (verified during planning)

- **Frontend:** Static Web App `prod-floorplan` (Standard, supports private endpoint),
  `rp-floorplan-rg`. Serves the **command-centre** Next.js app. Deploys via
  GitHub Actions (`.github/workflows/azure-static-web-apps-zealous-forest-041fd6a00.yml`)
  reading `NEXT_PUBLIC_AZURE_FUNCTIONS_URL` from a **GitHub repo variable** at build time.
  Production origin: `https://zealous-forest-041fd6a00.7.azurestaticapps.net`.
- **Backend (live):** `rpcc-functions` — **Consumption (Y1)**, `rp-floorplan-rg`.
  Y1 cannot join a VNet; must move to **Flex Consumption** in a new app.
- **Orphan:** `rp-cc-api` — empty Flex app, `rp-command-centre-rg`. Ignore;
  delete in cleanup. We'll create a fresh Flex app in `rp-floorplan-rg`.
- **SQL:** `rp-cc-sql-server` / db `free-sql-db-4148991` (Basic), `rp-floorplan-rg`.
  Public access **Enabled**; **AAD-only auth**; AAD admin = `connor@randazzo.properties`.
- **SQL auth is portable:** `db.ts` gets a token via **client-credentials flow**
  using `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET`. The DB
  login is that AAD app registration, already a SQL user → **new app needs no
  new DB user**, just the same env vars.
- **Easy Auth NOT enabled** — auth is code-level JWT (`src/auth.ts` + `requireRole`).
- **Platform CORS** on `rpcc-functions` allows the SWA origin + portal,
  `supportCredentials=true`. Replicate on the new app.
- **GitHub repo for the cutover:** `greatworkeveryone/command-centre`.

---

## Decisions locked in
- **Full lockdown:** SQL + frontend + API all behind private endpoints; public
  access disabled on all three after VPN is in place.
- **Fresh Flex Consumption app** (proposed name `rpcc-api2`) in `rp-floorplan-rg`.
- **Hybrid VPN** — deferred to the final phase:
  - **S2S** wiring the **office network** into the VNet → zero per-device
    friction in the office (no VPN client on staff desktops/laptops/phones on
    office wifi).
  - **P2S with Entra ID auth** on **phones** → field staff connect when off-site.
- **DNS forwarding for privatelink zones** — **decide at VPN time.** Two options:
  *(a)* office router forwards `privatelink.*` to Azure DNS (`168.63.129.16`) over
  the tunnel — free, needs a capable router; *(b)* Azure DNS Private Resolver in
  the VNet (~$73/mo) — clean and central. Without one of these, devices connect
  but name lookups break.
- **No NAT Gateway** unless an outbound IP allowlist forces it (open items
  checked — not needed).
- **Local dev**: continue to use a local SQL copy (`LOCAL_SQL=true`).

## Open decision — Graph webhook (`/api/graphNotification`)
**Microsoft Graph isn't on your VNet.** Once the API is private, Graph can't
deliver email notifications to it. This must be addressed before flipping the
API public-access off. **Three options:**

1. **Polling instead of webhooks** *(simplest, cheapest, recommended)* — disable
   Graph subscriptions; add a timer-triggered function that polls the mailbox
   every N minutes (e.g. 5 min) for new mail. Trade-off: 0–5 min delay instead
   of near-real-time.
2. **Keep `/api/graphNotification` reachable** via the Function App's **Access
   Restrictions** allowing Microsoft Graph's published source IP ranges only,
   while everything else stays private. Pros: keeps near-real-time delivery.
   Cons: Graph's IPs can change; requires monitoring/maintenance.
3. **Azure Front Door** in front of the private API — public ingress with WAF,
   proxies to the private origin. Cost: ~$22+/mo. Most "proper" but adds infra.

**This must be picked before the API public-access is disabled.**

## Cost summary (USD/mo, Australia East, ex-GST)
- Going private (no VPN):
  - 3 × private endpoints (SQL, SWA, API): ~$22
  - 3 × private DNS zones: ~$1.50
  - New storage account: ~$1
  - **Subtotal: ~$25/mo**
- New Flex compute: **~neutral** vs Y1 (pay-per-use); ~$0 once Y1 is stopped.
- **VPN (final phase):** VpnGw1 **~$140** + public IP **~$3.65** = ~$144/mo.
- Optional **Front Door** (if you pick option 3 for Graph webhook): **~$22+/mo**.
- VPN egress: variable; **use split-tunnel** to keep near $0.

## Open items — RESOLVED during checks
1. **Node version → 22.** App runs `WEBSITE_NODE_DEFAULT_VERSION=~22`, host `~4`. New Flex app uses `--runtime-version 22`.
2. **CORS → both platform + code.** Platform CORS allowed origins to copy: `https://portal.azure.com`, `https://zealous-forest-041fd6a00.7.azurestaticapps.net`, `supportCredentials=true`. Code also has CORS in `src/cors.ts`.
3. **Easy Auth NOT needed.** Auth is code-level JWT validation via JWKS in `src/auth.ts` + `requireRole`. Just copy app settings.
4. **NAT Gateway probably NOT needed.** External calls (MyBuildings, WordPress, Graph) are token-authed, not IP-allowlisted. *(One thing to verify with MyBuildings vendor if you can — they almost certainly don't allowlist by IP.)*
5. **GitHub repo:** `greatworkeveryone/command-centre`.

---

# DO NOW — safe, reversible (no irreversible steps; public access stays ON throughout)

> Constants: `RG=rp-floorplan-rg`, `LOC=australiaeast`, `VNET=vnet-rpcc`, `APP=rpcc-api2`.
> Commands reviewed against current `az` syntax — confirm any flag with `az <cmd> --help`.

### Phase 1 — Networking + private endpoint for SQL
**Why:** create the private network and a private path to SQL. Harmless while
SQL public access stays on.

```bash
# VNet + subnets
az network vnet create -g $RG -n $VNET -l $LOC --address-prefixes 10.20.0.0/16 \
  --subnet-name snet-pe --subnet-prefixes 10.20.1.0/24
az network vnet subnet create -g $RG --vnet-name $VNET -n snet-func \
  --address-prefixes 10.20.2.0/24 --delegations Microsoft.App/environments
az network vnet subnet create -g $RG --vnet-name $VNET -n GatewaySubnet \
  --address-prefixes 10.20.255.0/27
az network vnet subnet update -g $RG --vnet-name $VNET -n snet-pe \
  --private-endpoint-network-policies Disabled

# Private DNS zones (one per service kind)
az network private-dns zone create -g $RG -n privatelink.database.windows.net
az network private-dns zone create -g $RG -n privatelink.azurewebsites.net
az network private-dns zone create -g $RG -n privatelink.azurestaticapps.net
for ZONE in privatelink.database.windows.net privatelink.azurewebsites.net privatelink.azurestaticapps.net; do
  az network private-dns link vnet create -g $RG -z $ZONE \
    -n "link-${ZONE//./-}" --virtual-network $VNET --registration-enabled false
done

# Private endpoint for SQL + auto DNS A record
SQLID=$(az sql server show -n rp-cc-sql-server -g $RG --query id -o tsv)
az network private-endpoint create -g $RG -n pe-sql --vnet-name $VNET --subnet snet-pe \
  --private-connection-resource-id $SQLID --group-id sqlServer --connection-name pe-sql-conn
az network private-endpoint dns-zone-group create -g $RG --endpoint-name pe-sql \
  -n zg-sql --private-dns-zone privatelink.database.windows.net \
  --zone-name privatelink.database.windows.net
```
**Verify:** `az network private-endpoint show -g $RG -n pe-sql --query "privateLinkServiceConnections[0].privateLinkServiceConnectionState.status"` → `Approved`; DNS zone has an A record for `rp-cc-sql-server`.
**Rollback:** delete the PE + zones + VNet.

### Phase 2 — Build the new Flex backend (runs alongside Y1, public-inbound — no user impact)
```bash
az storage account create -g $RG -n rpccapistorage -l $LOC --sku Standard_LRS
az functionapp create -g $RG -n $APP --flexconsumption-location $LOC \
  --runtime node --runtime-version 22 --storage-account rpccapistorage
az functionapp vnet-integration add -g $RG -n $APP --vnet $VNET --subnet snet-func
```
- **Copy all app settings** from `rpcc-functions` → `$APP` (excluding plan/storage keys: `AzureWebJobsStorage`, `DEPLOYMENT_STORAGE_*`, `WEBSITE_RUN_FROM_PACKAGE`, `WEBSITE_NODE_DEFAULT_VERSION`, `FUNCTIONS_EXTENSION_VERSION`).
- **No Easy Auth to replicate** — auth is code-level JWT. Confirm the auth env vars `src/auth.ts` reads are in the copied settings.
- **Copy platform CORS**: `az functionapp cors add -n $APP -g $RG --allowed-origins https://zealous-forest-041fd6a00.7.azurestaticapps.net https://portal.azure.com`.
- **Deploy the code** to `$APP` (VS Code Azure Functions extension targeting the new app, or `func azure functionapp publish $APP`).

**Verify (public still on):** call `$APP`'s URL, confirm it returns real SQL data; in Kudu console, `nslookup rp-cc-sql-server.database.windows.net` → returns the **10.20.x** private IP.
**Rollback:** delete `$APP` + `rpccapistorage`.

### Phase 3 — Cutover the frontend (production-affecting, one-line revert)
```bash
gh variable set NEXT_PUBLIC_AZURE_FUNCTIONS_URL --repo greatworkeveryone/command-centre \
  --body "https://<APP-hostname>"
```
- Re-run the SWA workflow → frontend rebuilds against the new API.
- **Graph webhook:** set `GRAPH_NOTIFICATION_URL` on `$APP` and re-create the email subscriptions to the new URL.
- **Stop double-runs:** `az functionapp stop -n rpcc-functions -g $RG`.
- Soak; watch App Insights for errors.
**Rollback:** revert the GitHub variable + redeploy; `az functionapp start -n rpcc-functions`.

### Phase 4 — Private endpoints for SWA + API (still safe — public access remains ON)
**Why:** prepare the private paths for frontend and API. Until public access is
disabled (later, with VPN), users still reach both publicly. Pure infrastructure
setup, zero user impact.

```bash
# Private endpoint for the Function App (sites group)
APPID=$(az functionapp show -n $APP -g $RG --query id -o tsv)
az network private-endpoint create -g $RG -n pe-api --vnet-name $VNET --subnet snet-pe \
  --private-connection-resource-id $APPID --group-id sites --connection-name pe-api-conn
az network private-endpoint dns-zone-group create -g $RG --endpoint-name pe-api \
  -n zg-api --private-dns-zone privatelink.azurewebsites.net \
  --zone-name privatelink.azurewebsites.net

# Private endpoint for the Static Web App (staticSites group)
SWAID=$(az staticwebapp show -n prod-floorplan -g $RG --query id -o tsv)
az network private-endpoint create -g $RG -n pe-swa --vnet-name $VNET --subnet snet-pe \
  --private-connection-resource-id $SWAID --group-id staticSites --connection-name pe-swa-conn
az network private-endpoint dns-zone-group create -g $RG --endpoint-name pe-swa \
  -n zg-swa --private-dns-zone privatelink.azurestaticapps.net \
  --zone-name privatelink.azurestaticapps.net
```
**Verify:** both PEs report `Approved`; private DNS zones contain A records for the app + SWA hostnames pointing at 10.20.x addresses. Test that calling the public URL still works (it should — we haven't disabled public access yet).
**Rollback:** delete `pe-api` and `pe-swa` and their zone-group entries.

> 🛑 **Stop here until the VPN is ready.** Everything below requires the VPN to
> avoid locking yourself (and your users) out. SQL, SWA, and API are all still
> publicly reachable — auth-gated — and the private paths are now sitting ready
> for the day you flip the switches.

---

# DO LATER — VPN + go fully private (contains the irreversible flips)

### Phase 5 — VPN Gateway (hybrid: S2S office + P2S phones)
**Why:** wire the **office** into the VNet (S2S) for zero in-office friction;
provide **P2S** for phones used in the field. One gateway (VpnGw1) does both.

**Prereq (ask the network/IT team well ahead of this phase):** another
department handles the office router. Send them roughly this:

> "What router/firewall does the office run (make + model)? Does it support
> Site-to-Site IPsec VPN with IKEv2 (route-based)? Can it forward DNS queries
> for specific zones to a particular DNS server over the tunnel? Who would I
> coordinate with to configure it?"

Most modern business routers (Meraki, FortiGate, Ubiquiti, SonicWall, pfSense,
Cisco) handle this. If theirs doesn't, three fallbacks:
- **Upgrade the router** (their call, may take time/budget).
- **P2S-only** — everyone uses the Azure VPN client *even in the office*.
  Brings back per-device friction.
- **Small VPN appliance / Linux box in the office** as the S2S endpoint
  alongside existing kit (~$200 hardware + setup).

```bash
# Public IP and gateway (supports both S2S and P2S on the same VpnGw1)
az network public-ip create -g $RG -n pip-vpngw --sku Standard --allocation-method Static
az network vnet-gateway create -g $RG -n vpngw-rpcc --vnet $VNET \
  --public-ip-address pip-vpngw --gateway-type Vpn --vpn-type RouteBased \
  --sku VpnGw1 --address-prefixes 172.16.0.0/24      # ~30–45 min to provision

# Point-to-Site with Entra ID auth (phones / off-office laptops)
# az network vnet-gateway aad assign ...  (Entra tenant + audience; configure
# via the Azure VPN Client config so phones use the official Azure VPN app)

# Site-to-Site to the office:
# 1. Local Network Gateway representing the office (its public IP + LAN CIDRs)
#    az network local-gateway create -g $RG -n lng-office \
#      --gateway-ip-address <office-public-ip> --local-address-prefixes <office-LAN-CIDR>
# 2. Connection between the VPN Gateway and the Local Network Gateway
#    az network vpn-connection create -g $RG -n cn-office \
#      --vnet-gateway1 vpngw-rpcc --local-gateway2 lng-office \
#      --shared-key '<strong-PSK>'
# 3. Configure the office router with matching IKEv2 + PSK + traffic selectors.
```

**DNS — decide now (the deferred decision):**
For office S2S clients (and P2S clients) to resolve `privatelink.*` to the
private IPs, name resolution must reach Azure Private DNS. Pick one:
- **Office router DNS forwarding** *(free)* — configure the router to forward
  queries for `privatelink.database.windows.net`, `privatelink.azurewebsites.net`,
  `privatelink.azurestaticapps.net` to `168.63.129.16` via the tunnel. Requires
  router that can do conditional forwarding.
- **Azure DNS Private Resolver** *(~$73/mo)* — deploy an inbound endpoint in the
  VNet; point office DNS + P2S client DNS at its private IP. Cleaner, less router
  config, the production-grade answer.

**Gate before the flips:** from one VPN-connected office device **and** one
P2S-connected phone, verify:
- Azure Data Studio reaches SQL (over the private endpoint).
- The SWA URL loads in a browser.
- The API URL responds.
If any fails, **do not flip** — fix the VPN/DNS first.

### Phase 6 — Decide and implement the Graph webhook plan
Pick from the three options above (recommendation: **polling**). Whatever you
pick must be in place *before* the API public-access is disabled, or Graph
notifications stop flowing.

### Phase 7 — Disable public access (the irreversible-ish flips)
Each is one command, each is independently reversible by re-enabling the flag.
**Do them one at a time, with a verify after each.**

```bash
# 1. SQL
az sql server update -n rp-cc-sql-server -g $RG --enable-public-network false
# verify the app still works; verify Azure Data Studio still works over the VPN.

# 2. API (Function App) — disable public access; private endpoint takes over
az functionapp update -n $APP -g $RG --set publicNetworkAccess=Disabled
# verify the frontend (loaded over VPN) reaches the API; verify Graph webhook plan works.

# 3. SWA — disable public access; private endpoint takes over
az staticwebapp update -n prod-floorplan -g $RG --public-network-access Disabled
# verify staff on the VPN can load the app; verify off-VPN cannot.
```

**Rollback any one:** flip its flag back to `true`/`Enabled`.

> **Production gotcha (CI / deploys when private):**
> - **SWA deploys** generally still work — they go via the SWA management plane, not the static content endpoint.
> - **Function App deploys via GitHub-hosted runners may fail** once public is off (deploy uses the SCM site which is gated by the PE). Options:
>   - **VS Code deploy from your laptop while on the VPN** (simplest).
>   - **Self-hosted GitHub runner in the VNet** (more setup, automated).
>   - **Temporarily re-enable public access for deploy windows** (pragmatic).

### Phase 8 — Cleanup
- Delete orphan `rp-cc-api` + its App Insights component.
- Delete `rpcc-functions` once you're confident (keep it stopped as a rollback first for a couple of weeks).

---

## Daily reality after full lockdown (S2S office + P2S phones)
- **In the office (wifi/wired): zero per-device friction.** S2S puts the office
  network on the VNet, so any device connected to office wifi/ethernet — laptops,
  desktops, phones on office wifi — reaches the app normally. No VPN client, no
  prompts, no per-user setup.
- **Phones off-office (mobile data, field, home):** Azure VPN client installed
  once per phone, Entra sign-in, one tap to connect when they need the app. Can
  be always-on.
- **Off-network with no VPN client:** can't reach the app at all. Plan for
  contractor / temp / personal-device access — VPN client onboarding or accept
  they can't use it.
- **Portal Query Editor for SQL stops working** — use Azure Data Studio over
  any VPN path (office wifi or P2S).
- **Production migrations** run manually from any VPN-connected machine (a
  laptop on the office network counts).

## Tooling notes for local dev (unchanged by all this)
- Keep developing against a **local SQL copy** (`LOCAL_SQL=true`, `SQL_USERNAME`/`SQL_PASSWORD` in `local.settings.json`).
- VS Code deploys to the Function App from the VPN once public access is off.
