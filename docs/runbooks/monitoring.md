# Monitoring: access patterns and the money-action gate

Owner: Will (Azure). Sprint packages S10 (access monitoring, decision 15) and
S11 (money-action gate, decision 16); the Azure side is O4/O7. Every change in
Azure below needs Connor's yes first.

## 1. What the app records

Every sign-in (`registerSelf`), every money action (S11's gate), the first
request per person per 15 minutes, and bursts (more than 300 requests in 5
minutes from one person on one instance) go to `dbo.AccessEvents` (migration
131). Each row is checked against the person's expected-use profile
(`AppUsers.AccessProfile`; NULL = role default: Darwin, 06:00–20:00, Mon–Sat,
AU, call-outs for facilities roles) and gets one of:

| Anomaly          | Rule                                                                                         |
|------------------|----------------------------------------------------------------------------------------------|
| `new_country`    | the browser's country hint (`x-fp-country`) is not in the profile's countries                 |
| `outside_window` | a money action, or any request by a non-director/non-admin without call-outs, outside the window |
| `new_device`     | user-agent hash not seen for that person in 90 days (the first device ever is a baseline)     |
| `burst`          | more than 300 requests in 5 minutes from one person (per instance)                            |

An anomaly also writes an `access.anomaly` exception to the decision ledger
(at most once per person and rule every 6 hours per instance) and one trace
line starting `[access] anomaly {json}` (no names, no addresses). Nothing is
blocked by S10.

The in-app country is the browser's claim. **App Insights' own geolocation of
the request is the source of truth for alerts** (rule A below). Neither is
trusted alone.

Admin → Users → Access profile edits a person's profile (admin only, ledgered
as `access.profile_change`). Admin → Recent sign-ins and anomalies shows the last
7 days, filterable by person (CFO, directors, admin).

**First thing after deploy:** set Connor's profile — time zone
`Europe/Copenhagen`, countries `DK, AU`, all days, hours to suit. Until then
every request he makes from Denmark is a `new_country` anomaly.

## 2. Settings

| Setting                 | Default            | Meaning                                                                                       |
|-------------------------|--------------------|-----------------------------------------------------------------------------------------------|
| `ACCESS_REPORT_ENABLED` | unset (off)        | `"true"` registers `accessReportTimer`: 07:00 Darwin daily, emails active `admin` and `cfo` users the last 24 h of anomalies, only when there were any. Needs Graph mail (`GRAPH_SENDER_EMAIL`). Honours `DEV_EMAIL_OVERRIDE`. |
| `ACCESS_LOG_ENABLED`    | on                 | `"false"` stops all access logging (the off switch if it ever misbehaves).                    |
| `ACCESS_HASH_KEY`       | built-in constant  | Key for the address and user-agent hashes. Set a random 32+ character secret (Key Vault reference). Without it an IPv4 hash can be reversed by brute force. Rotating it resets device history (90 days of `new_device` noise), so rotate only on a leak. |

## 3. Confirm the platform passes the client address (do this first, from the office)

The access log and the money gate read the client address from
`X-Forwarded-For` (the rightmost public address, so a caller cannot spoof it by
sending their own header). Flex Consumption should set it; confirm:

1. From an office desktop, signed in as an admin, open
   `https://<api>/api/health?deep=true` (any admin token; the frontend's System
   panel or a REST client).
2. In App Insights → Logs:

   ```kusto
   traces
   | where timestamp > ago(30m)
   | where message startswith "health: client address headers"
   | project timestamp, message
   ```

3. Expect `{"clientIpHeader":…,"entries":1,"forwardedFor":true,…}`. `forwardedFor:false`
   means the platform does not pass it: stop and tell the S11 owner (the money
   gate would refuse every money action once `MONEY_ALLOWED_CIDRS` is set).
   `entries` of 2 or more is fine; note it in the evidence.

## 4. App Insights alert rules

Create each as a log search alert on the Function App's Application Insights
resource, action group = email Will + Connor (O4). Evaluate every 15 minutes
over the last 15 minutes unless stated; alert when the result has any rows.

Darwin is UTC+09:30 all year; the rules shift `timestamp` by that.

### A. New country (severity 1) — source of truth

Requests from outside the countries anyone is expected in. App Insights
geolocates the request's client address at ingestion.

```kusto
requests
| where timestamp > ago(15m)
| where isnotempty(client_CountryOrRegion)
| where client_CountryOrRegion !in ("Australia", "Denmark")
| summarize requests = count(), functions = make_set(name, 10) by client_CountryOrRegion, client_City
```

Plus the in-app view (the browser's claim against each person's profile):

```kusto
traces
| where timestamp > ago(15m)
| where message startswith "[access] anomaly"
| extend a = parse_json(substring(message, strlen("[access] anomaly ")))
| where tostring(a.anomaly) == "new_country"
| project timestamp, userId = toint(a.userId), role = tostring(a.role), country = tostring(a.country)
```

### B. Money action outside the window (severity 1)

Any request to a gated money endpoint outside 06:00–20:00 Mon–Sat Darwin.
Keep the name list in step with `src/money-gated-routes.ts`.

```kusto
let gated = dynamic(["setApprovalLimit", "upsertPayment", "markPaymentPaid", "directorApproveJobInvoice", "markPurchaseOrderMyobCreated"]);
requests
| where timestamp > ago(15m)
| where name in (gated)
| extend darwin = timestamp + 9h + 30m
| where hourofday(darwin) < 6 or hourofday(darwin) >= 20 or dayofweek(darwin) == 0d
| project timestamp, darwin, name, resultCode, client_CountryOrRegion
```

### C. Burst (severity 2)

Per person, from the app (counted per instance):

```kusto
traces
| where timestamp > ago(15m)
| where message startswith "[access] anomaly"
| extend a = parse_json(substring(message, strlen("[access] anomaly ")))
| where tostring(a.anomaly) == "burst" or set_has_element(todynamic(a.alsoFlagged), "burst")
| project timestamp, userId = toint(a.userId), role = tostring(a.role)
```

Across all instances (the app cannot see this): more than 3,000 requests in any
5 minutes is far above pilot use.

```kusto
requests
| where timestamp > ago(15m)
| summarize n = count() by bin(timestamp, 5m)
| where n > 3000
```

### D. New device (severity 3, no page)

Daily digest material, not an alert; create it with a 24-hour window and a
once-a-day evaluation, or rely on the daily email (`ACCESS_REPORT_ENABLED`).

```kusto
traces
| where timestamp > ago(24h)
| where message startswith "[access] anomaly"
| extend a = parse_json(substring(message, strlen("[access] anomaly ")))
| where tostring(a.anomaly) == "new_device" or set_has_element(todynamic(a.alsoFlagged), "new_device")
| summarize events = count() by userId = toint(a.userId), role = tostring(a.role)
```
