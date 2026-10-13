# WP22 step 0 — ABS CPI structure check

Checked live against the public, keyless ABS Data API on 2026-10-13 (about 15:00–15:15 UTC),
before any parser code. This is the evidence the parser, key builder and sync are built on.
The PLAN asks for these findings in `progress.md`; this file is the backend-repo record, and
the one-paragraph summary below is what to mirror there.

## Summary (settled)

| Question | Answer |
|---|---|
| Dataflow | `CPI`, version 2.0.0 (agency `ABS`). `CPI_Q` 1.0.0 cannot serve this (see below). |
| Key | `MEASURE.INDEX.TSEST.REGION.FREQ` (5 dimensions). All groups, Original, Quarterly: `1.10001.10.<region>.Q` |
| AUS key | `1.10001.10.50.Q` (REGION 50, labelled "Australia"; `CPI_Q` labels the same code "Weighted average of eight capital cities") |
| Darwin key | `1.10001.10.7.Q` (REGION 7) |
| Darwin quarterly history | Same dataflow, same key shape. 1980-Q3 to 2026-Q2 (184 quarters). It was never "elsewhere". The `…50+7.Q` multi-region query is what truncates it (see below). |
| AUS quarterly history | 1948-Q3 to 2026-Q2 (312 quarters) |
| From 2000-Q1 | 106 contiguous quarters per region, 2000-Q1 to 2026-Q2, no gaps |
| Latest quarter | 2026-Q2 (Jun-2026). The monthly series (FREQ M) currently ends 2026-08. |
| Reference base | `BASE_PERIOD` dataset attribute, code `25`, label `Sep 2025 = 100.0` |
| Response format | SDMX-JSON **2.0** (`data.structures[0]`, `data.dataSets[0]`). Request with `Accept: application/vnd.sdmx.data+json; version=2.0.0` |

## Calls made (all GET, no key)

Base: `https://data.api.abs.gov.au/rest`

| Call | Result |
|---|---|
| `/dataflow/ABS/CPI?detail=full` | 200. `CPI` 2.0.0, "Consumer Price Index (CPI)". Default view `MEASURE=3,REGION=50,FREQ=M,LASTNPERIODS=4` (monthly). |
| `/dataflow/ABS/CPI_Q?detail=full` | 200. `CPI_Q` 1.0.0, "Consumer Price Index (CPI) Quarterly". |
| `/dataflow/ABS/CPI_M?detail=full` | 200. `CPI_M` 1.2.0, description starts "CEASED". |
| `/dataflow/ABS?detail=allstubs` | 200. 1227 dataflows; CPI-family: `CPI`, `CPI_M`, `CPI_Q`, `CPI_WEIGHTS`. |
| `/datastructure/ABS/CPI/2.0.0?references=children&detail=full` | 200. Dimensions and codelists below. |
| `/datastructure/ABS/CPI_Q/1.0.0?references=children&detail=full` | 200. Same five dimensions, different codelists. |
| `/data/CPI/1.10001.10.50.Q?startPeriod=2000-Q1` | 200, 106 observations (2000-Q1 to 2026-Q2). Saved as fixture. |
| `/data/CPI/1.10001.10.7.Q?startPeriod=2000-Q1` | 200, 106 observations. Saved as fixture. |
| `/data/CPI/1.10001.10.50.Q` and `/7.Q` (no startPeriod) | 200, 312 and 184 observations. |
| `/data/CPI/1.10001.10.50.M?startPeriod=2025-06` and `/7.M` | 200, 15 monthly observations each, 2025-06 to 2026-08. |
| `/data/CPI/1.10001.10.50+7.Q?startPeriod=2000-Q1` | 200 but **truncated**: 1 observation per series. Saved as a regression fixture. |
| `/data/CPI/1.10001.10..Q?startPeriod=2024-Q1` (region wildcard) | 200, all 9 regions, 10 observations each (complete). |
| `/data/CPI/1.10001.10.1+2.Q?startPeriod=2024-Q1` | 200 but Sydney has 1 observation, Melbourne 10 (truncation is not specific to 50+7). |
| `/data/CPI_Q/1.10001.10.50.Q`, `/data/CPI_Q/..10.50.Q` | 404 `NoRecordsFound` |
| `/data/CPI_Q/all?lastNObservations=1` | 200, ~90 series, all `TSEST=20` and `REGION=50`. |
| `/data/CPI/1.10001.20.50/all?startPeriod=2024` (the old timer's key) | 422 `Not enough key values in query, expecting 5 got 4` |

Latency was 0.6–2.2 s per call.

## Data structure

`CPI` 2.0.0 series dimensions, in key order:

| Pos | Dimension | Codes used |
|---|---|---|
| 0 | MEASURE | `1` Index numbers (others: 2 and 3 are % changes, 4–7 contributions) |
| 1 | INDEX | `10001` All groups CPI |
| 2 | TSEST | `10` Original (20 = Seasonally Adjusted, 30 = Trend) |
| 3 | REGION | `50` Australia, `1` Sydney, `2` Melbourne, `3` Brisbane, `4` Adelaide, `5` Perth, `6` Hobart, `7` Darwin, `8` Canberra |
| 4 | FREQ | `Q` Quarterly (`M` Monthly) |
| time | TIME_PERIOD | `YYYY-Qn` for FREQ Q |

Dataset attribute `BASE_PERIOD` exists on `CPI` 2.0.0 only (not on `CPI_Q`). Series attribute `UNIT_MEASURE=IN`.
Observation attributes `OBS_STATUS`, `DECIMALS`, `OBS_COMMENT` are declared with no values, so
observation arrays are just `[value]`.

## Findings

### 1. The old timer was wrong three ways (confirms PLAN F6) and a fourth way nobody noted

- Key `1.10001.20.50` has 4 values; the dataflow needs 5 (422).
- It read SDMX-JSON 1 paths (`structure`, `dataSets` at top level). The API serves 2.0 for
  `Accept: application/vnd.sdmx.data+json` (`data.structures[0]`, `data.dataSets[0]`).
- `TSEST=20` is Seasonally Adjusted, not Original.
- It passed `TYPES.Decimal` with no precision/scale. `SqlParam.options` documents that tedious
  then defaults to scale 0, so `102.31` would have been stored as `102`.

### 2. Reference base is a month, not a year

`BASE_PERIOD` = code `25`, label **`Sep 2025 = 100.0`**. Monthly September 2025 is exactly 100 for
both AUS and Darwin. The quarterly index is the mean of its three months, so 2025-Q3 is
**99.73 (AUS) and 99.66 (Darwin)**, not 100 (verified: (99.63+99.55+100)/3 = 99.727; Darwin
(99.52+99.47+100)/3 = 99.663; 2026-Q2 likewise matches the monthly mean). The PLAN label example
"base 2025 = 100" should read "base Sep 2025 = 100.0". The label comes from the response
(`structure.attributes.dataSet[BASE_PERIOD].values[].name`); the codelist in the data-structure
call only says `25 = 2025 = 100.0`, so the data response is the authority and must be read per fetch.

Sample values: AUS 2000-Q1 48.40, 2025-Q4 100.32, 2026-Q1 101.70, 2026-Q2 102.31.
Darwin 2000-Q1 51.09, 2025-Q4 100.33, 2026-Q1 101.27, 2026-Q2 102.35.

### 3. Darwin history is in `CPI`; the multi-value key is what loses it

On the same day the PLAN saw only 2025-Q4 for Darwin from `CPI/1.10001.10.50+7.Q`. Requesting
Darwin by itself returns 184 quarters from 1980-Q3. Requesting `50+7` returns **one observation
per series at an arbitrary period** (2017-Q1 with `startPeriod=2000-Q1`; 1986-Q2 for AUS and
2018-Q2 for Darwin without it), and `1+2` truncated Sydney only. The result is repeatable, comes
back as HTTP 200 with `errors: []`, and also happens with `detail=dataonly`. It is specific to
the default time-series layout: `dimensionAtObservation=AllDimensions` returns all 212 observations
(106 per region) for the same `50+7` key, and single-value keys and an empty (wildcard) region are
complete. Consequence: **one request per region in the default layout, never `+`**, and the
parser/sync must reject any series that is not contiguous from the requested start period,
because a truncated response is otherwise indistinguishable from a good one.

The time dimension `values` array is **not chronological** (2026-Q2 first, then 2000-Q2, 2000-Q3,
…, 2026-Q1 last in the single-region responses; fully shuffled in the multi-region one).
Observation keys are indexes into that array. A parser must map index to `values[i].id` and
sort afterwards; assuming order silently scrambles the series.

### 4. `CPI_Q` is not usable

It holds national (REGION 50) seasonally adjusted series only on the old index base (all-groups SA
147.5 in 2026-Q2, values delivered as strings). `…10.50.Q` (Original) and every Darwin key return
404 `NoRecordsFound`. It has no `BASE_PERIOD` attribute. Do not source anything from it.

### 5. Content negotiation

| Accept | Result |
|---|---|
| `application/vnd.sdmx.data+json; version=2.0.0` | 200, SDMX-JSON 2.0. **Use this.** |
| `application/vnd.sdmx.data+json` | 200, SDMX-JSON 2.0 (current default; could change) |
| `application/vnd.sdmx.data+json; version=1.0.0` | 406 |
| `application/json` | 200 but the legacy SDMX-JSON 1 shape (`header`/`dataSets` at top level) |
| none | 200 as XML (`genericdata+xml`) |

A versioned flow reference needs the agency: `/data/ABS,CPI,2.0.0/…` works; `/data/CPI,2.0.0/…` is a
404 "Could not find Dataflow and/or DSD". The sync requests the unversioned `CPI` and records the
version actually served (from the `DataStructure` URN in `dataSets[0].links`), then validates the
dimension layout, so an incompatible future version fails loudly instead of silently reading
the wrong series.

### 6. Noise that is not a signal

Every response carries `meta.test: true`, and the dataflow annotation `NonProductionDataflow=true`
is on 1226 of 1227 ABS dataflows. Both are ABS-wide; neither says anything about CPI.

## Response shape (SDMX-JSON 2.0, trimmed)

```json
{
  "meta": { "schema": ".../sdmx-json-data-schema.json (2.0.0)", "prepared": "2026-10-13T15:13:08Z", "test": true },
  "data": {
    "dataSets": [{
      "structure": 0,
      "action": "Information",
      "links": [{ "urn": "urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=ABS:CPI(2.0.0)", "rel": "DataStructure" }],
      "attributes": [0],
      "series": {
        "0:0:0:0:0": { "attributes": [0], "annotations": [], "observations": { "0": [102.31], "1": [48.77], "…": [] } }
      }
    }],
    "structures": [{
      "dimensions": {
        "series": [
          { "id": "MEASURE", "keyPosition": 0, "values": [{ "id": "1", "name": "Index numbers" }] },
          { "id": "INDEX",   "keyPosition": 1, "values": [{ "id": "10001", "name": "All groups CPI" }] },
          { "id": "TSEST",   "keyPosition": 2, "values": [{ "id": "10", "name": "Original" }] },
          { "id": "REGION",  "keyPosition": 3, "values": [{ "id": "50", "name": "Australia" }] },
          { "id": "FREQ",    "keyPosition": 4, "values": [{ "id": "Q", "name": "Quarterly" }] }
        ],
        "observation": [{
          "id": "TIME_PERIOD", "keyPosition": 5,
          "values": [
            { "id": "2026-Q2", "start": "2026-04-01T00:00:00", "end": "2026-06-30T00:00:00" },
            { "id": "2000-Q2", "…": "…" }
          ]
        }]
      },
      "attributes": {
        "dataSet": [{ "id": "BASE_PERIOD", "values": [{ "id": "25", "name": "Sep 2025 = 100.0" }] }],
        "series":  [{ "id": "UNIT_MEASURE", "values": [{ "id": "IN", "name": "Index Numbers" }] }],
        "observation": [{ "id": "OBS_STATUS" }, { "id": "DECIMALS" }, { "id": "OBS_COMMENT" }]
      }
    }]
  },
  "errors": []
}
```

Series key `0:0:0:0:0` is one index per series dimension, in dimension order. `dataSet.attributes[i]`
is an index into `structure.attributes.dataSet[i].values`.

## What this fixes in the build

- Fetch: one request per region, `Accept` pinned to 2.0.0, `startPeriod=2000-Q1`, 30 s timeout, 3
  attempts with doubling backoff for network errors, timeouts, a non-JSON 200, and HTTP 408, 425, 429
  and 5xx only (404/406/422 are deterministic and fail at once).
- Parse: SDMX-JSON 2.0 only; map observation index through `TIME_PERIOD.values`; read `BASE_PERIOD`
  per response (fail if absent); assert the series is MEASURE 1 / INDEX 10001 / TSEST 10 /
  REGION as requested / FREQ Q; reject `errors`, a missing dataset, non-numeric values, duplicate
  periods, a missing value, any series that is not contiguous from the requested start, and one whose
  latest quarter is more than four quarters behind the clock.
- Store: both regions fetched and validated (and agreeing on the base) before any write; one
  transaction; rows are rewritten with `ReferenceBase`, `SourceKey`, `Dataflow` whenever any of them or
  the value differs (so a rebase restates every row), matching rows are only confirmed; a base
  different from the stored one is logged and sent to Sentry as a warning, judged from the stored rows
  inside the fetched range only (an older row a fetch cannot refresh is reported as not refreshed, not
  as a rebase on every run); a latest period older than what is stored, or a decimal with more than 3
  places (column is `DECIMAL(10,3)`), is refused.
- Pass scale explicitly to tedious (`precision 10, scale 3`).
- Opt-in: a rebase rewrites existing rows, so the timer does nothing unless `CPI_SYNC_ENABLED` is
  exactly `true`. `CPI_SYNC_DRY_RUN` exactly `true` fetches, reads the table and logs each region's
  plan (insert / update / restate, base change yes or no, latest period) without writing, whether or
  not the sync is enabled. Run the dry run before the first real one. Both are Function App settings
  (and `local.settings.json` for a local run); nothing else ever sets them.

## Where this differs from the PLAN text

- PLAN says to record findings in `progress.md`; recorded here (backend repo) as instructed for this session.
- PLAN says Darwin history may live elsewhere; it does not (finding 3).
- PLAN example label "base 2025 = 100"; actual label is `Sep 2025 = 100.0` and quarterly 2025-Q3 is not 100 (finding 2).

## Reproduce

```sh
curl -sS -H 'Accept: application/vnd.sdmx.data+json; version=2.0.0' \
  'https://data.api.abs.gov.au/rest/data/CPI/1.10001.10.7.Q?startPeriod=2000-Q1'
```

Fixtures (real responses, unmodified): `src/__tests__/fixtures/abs-cpi/`
`cpi-2.0.0-aus-q-from-2000q1.json`, `cpi-2.0.0-darwin-q-from-2000q1.json`,
`cpi-2.0.0-multi-region-truncated.json`.
