# Security notes — azure-functions (rpcc-api2)

Dependency-audit state and the reasoning behind every `overrides` entry. The
shared rules (7-day age, ranged override keys, `npm ci`, etc.) live in
`../CLAUDE.md` → Security Practices. Keep this file in step with
`package.json` → `overrides`.

**Do not run `npm audit fix` in this repo.** It drags the
`exceljs` → `archiver` → `glob`/`minimatch` subtree into vulnerable ranges.
Use targeted `overrides` instead.

## Status (28 October 2026)

| Scope | Result |
| --- | --- |
| `npm audit --omit=dev` (CI gate scope) | 2 moderate — `uuid <11.1.1` via `exceljs` (accepted, see below) |
| `npm audit` (full, incl. dev) | + 3 high and 6 low, all dev-only and unfixable today (see below) |

No high or critical in prod, so CI gates at `--audit-level=high`
(`deploy.yml`, `security.yml`, `.githooks/pre-push`). `@sentry/node` is
10.66.0. `typescript` and `@types/pdfkit` are devDependencies, so the release
zip (`npm ci --omit=dev`) does not ship them.

## Overrides

```jsonc
"overrides": {
  "@azure/msal-node": "7.1.0",        // prod; GHSA-xcx6-jx8p-x3h5, fixed range >=7.1.0
  "tmp": "0.2.7",                     // dev
  "js-yaml@^3.0.0": "3.15.2",         // dev
  "js-yaml@^4.0.0": "4.3.2",          // dev
  "brace-expansion@^2.0.0": "2.1.7",  // dev
  "browserslist@^4.0.0": "4.28.7",    // dev (ts-jest/eslint) + its data deps below
  "baseline-browser-mapping@^2.0.0": "2.11.27",
  "caniuse-lite@^1.0.0": "1.0.30001814",
  "electron-to-chromium@^1.0.0": "1.5.444",
  "node-releases@^2.0.0": "2.0.57"
}
```

### `@azure/msal-node` 7.1.0

Pulled in only by `tedious` → `@azure/identity` 4.13.1, which declares
`msal-node ^5`; identity's newest release (4.14.0) still declares `^6`, so no
parent fix exists. The 6.0 / 7.0 breaking changes are confined to
`acquireTokenInteractive`, which nothing here uses — `src/db.ts` passes a
pre-acquired token via `azure-active-directory-access-token`. The override also
bumped its nested `msal-common` 16.6.2 → 16.14.2. Released 13 Oct 2026.
7.1.1 (21 Oct) and 7.1.2 (27 Oct) exist; neither is an advisory fix, so leave
the pin until one clears the 7-day rule and there is a reason to move.

### Dev-only leftovers, unfixable today

- `azure-functions-core-tools@4.10.0` ships an `npm-shrinkwrap.json`, which
  `overrides` cannot reach, so its nested `extract-zip@2.0.1` (high, no fixed
  2.x release exists) and `brace-expansion@2.0.2` (high) stay put. 4.16.0
  (12 Oct 2026) still shrinkwraps `extract-zip` 2.0.1 and a vulnerable
  `brace-expansion` 5.0.9, so bumping does not help. Dev CLI only; never in the
  release zip.
- `deepmerge@4.3.1` (GHSA-gcqx-w48m-w2h4, low) under `jest` / `ts-jest`. The
  advisory range is `>=4.2.0` and 4.3.1 is the newest release, so no fixed
  version exists.
- `sprintf-js@1.0.3` remains only under jest in the dev tree.

## Accepted exception: exceljs

`exceljs@4.4.0` is the sole root of the remaining `uuid` moderate (no
non-breaking fix; `audit fix --force` suggests a nonsense `exceljs@3.4.0`
downgrade — ignore it). It sits below the `high` gate. The advisory is a
missing buffer bounds check in uuid v3/v5/v6 when a `buf` argument is supplied;
nothing here passes one.

`archiver` (and so `glob`/`minimatch`/`brace-expansion`) is required from
exactly one file — `exceljs/lib/stream/xlsx/workbook-writer.js`, the streaming
writer. `src/functions/keys.ts` uses only the non-streaming path
(`new ExcelJS.Workbook()`, `wb.xlsx.writeBuffer()`, `wb.xlsx.load()`), which
goes through JSZip, so that subtree is never loaded.

Re-evaluate this exception if any of these change:

- `src/functions/keys.ts` starts using `ExcelJS.stream` / `WorkbookWriter` —
  that loads `archiver`
- a new `exceljs` release appears (4.4.0 is from Oct 2023 and still latest;
  effectively unmaintained)
- a **high or critical** shows up under this subtree, which the gate will catch

Longer term the honest fix is replacing exceljs, since it is both unmaintained
and the only blocker here. Not urgent — it backs a working keys import/export
feature (xlsx template with dropdown data validation, plus xlsx parsing).

## Gates

- `.github/workflows/security.yml` and `deploy.yml`:
  `npm audit --omit=dev --audit-level=high` (security.yml also runs
  `npm audit signatures`).
- `.githooks/pre-push`: same audit plus a lock-file sync check. Enable per clone
  with `git config core.hooksPath .githooks`; bypass a known-accepted failure
  with `git push --no-verify`, or set `git config hooks.skipAudit true`
  (the hook reports when it is skipping).
