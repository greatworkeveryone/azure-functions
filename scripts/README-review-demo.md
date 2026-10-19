# Local client-demo pack

This is fictional operational data on the real reference building portfolio. It is separate from production migrations and hard-coded to **localhost / floorplan_review**. It never reads cloud settings or sends mail, publishes vacancies, creates payments or writes to MYOB.

## Run

With Node 22, in this repository:

1. `node scripts/local-review.cjs prepare --skip-build` prepares SQL/reference data and seeds the database-only portion. Omit `--skip-build` when the backend needs compiling.
2. Start `node scripts/local-review.cjs storage` in another terminal. This uses the existing `.review-local/storage` directory and Azurite's SDK compatibility option.
3. `node scripts/local-review.cjs demo` attaches sample evidence PDFs in local storage. It can also be rerun independently while the review stack is running.
4. Sign in locally as the review admin. **Show test data** must be on. This is remembered per account/device and restored when the main header mounts.

The schema must already include the integrated review migrations and the 20-property reference portfolio (19 occupied/reference properties and one development site). Synthetic colleague accounts are created by `prepare`. A fresh database can be seeded without starting Azurite; only evidence attachment requires storage.

## Included scenarios

- 38 jobs across New, Quote, Awaiting approval, Work, Tenant and Done, with stalled and overdue examples.
- 23 quotes, 11 draft purchase orders, 11 invoices, 34 PDF attachments. Documents match the linked amounts and contain prominent fictional-use labels. There is no simulated MYOB export or paid status.
- 3 admin decision requests routed to the director role; 38 fictional creation ledger entries.
- 25 tenancy/household records and occupancy cells, including six vacated commercial suites linked to six draft vacancies. Household examples do not imply commercial rent. Commercial examples include upcoming/overdue review dates, expiry windows and holdover.
- 19 draft inspections with levels, rooms and findings; 17 linked inspection-raised jobs. Earlier completed inspection examples remain available from the base review seed.
- 19 assets/locations and recurring service schedules; relevant HVAC jobs link to the corresponding equipment.
- 19 keys and four checkout examples (overdue, upcoming and returned).
- 6 incoming work requests, 6 fictional emails, 9 contractors and 2 timesheets awaiting approval. Email visibility also depends on the existing mailbox-mode settings.
- Existing six draft procedures and Finance configuration come from the base preparation.

## Review journeys

1. **Overview → Building view → 30 Daly St:** switch buildings through the single illustrated header and open a linked job.
2. **Jobs:** inspect pending quotes, manager approvals, an 8% invoice rise, stalled work and completed examples. `[DEMO]` identifies fictional jobs.
3. **Incoming:** promote a demo request or review a fictional email. All addresses use `.invalid` domains.
4. **Inspections:** open a new building inspection, inspect its finding and follow the already raised job link. Existing base examples cover completed states.
5. **Registers:** inspect keys/loans, tenancy dates, vacant areas, assets and service schedules.
6. **Finance → Audit log:** inspect fictional creation history. Pending decisions remain an existing job/inbox flow; the proposed decision-packet presentation is a later slice.

## Repeatability and limits

`dbo.ReviewDemoRecords` tracks fixture identities. `dbo.ReviewDemoBuildingOrder` fixes scenario positions so adding another property cannot shift existing workflow states or identifiers. Development sites receive no invented tenancy, HVAC or inspection fixtures. Rerunning does not reset edited records, relative dates or financial statuses. Dates are relative to the first seed, so overdue scenarios naturally age. Evidence blobs use deterministic, valid job-scoped names; existing blobs are preserved. To rehearse a completely fresh demo, use a separately provisioned disposable review database rather than deleting records from this one.

Reports are written to `.review-local/logs/demo-pack.json`; openable PDF copies are under `.review-local/documents/`. The pack validates same-building asset/tenancy links and approved-quote ownership before committing SQL.

**Role limitation:** existing product policy excludes test records for non-admin roles. This pack deliberately retains `IsTest` and egress protections. A separate isolated demo mode is needed for complete director/CFO/staff role demonstrations. No production permission was widened here. Real mail delivery, MYOB, background workers, fresh migration rehearsal and full client acceptance remain outside this pack.


Reference corrections on 19 October: Melville St Flats uses 7 Melville St, The Gardens NT 0820; residences use Carlo & Maria and Paolo & Kirstin; Old Red Cross Site at 19 Schultz St belongs to Development Sites. The placeholder building and linked sample records were removed with a local backup. The setup imports the real reference fixtures before inspection examples and never recreates the placeholder.
