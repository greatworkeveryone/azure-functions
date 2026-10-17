/// <reference types="jest" />

// The M2 reviewer's scenarios (18 Oct), kept in the suite, now asserting the fix.

import { parseCsv, toCsv } from "./csv";
import type { MappingRefs } from "./mappingKinds";
import { planImport } from "./planImport";

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const SUP = "11111111-2222-4333-8444-555555555555";
const csv = `company_file_id,contractor_id,supplier_uid,supplier_name,abn\r\n${CF},7,${SUP},ACME Air Pty Ltd,51824753556\r\n`;
const refs = (contractorAbn: string | null): MappingRefs => ({
  buildings: new Map(), contractors: new Map([[7, { abn: contractorAbn, name: "ACME Air" }]]), existing: new Map(), files: new Map([[CF, "Demo Pty Ltd"]]),
});

it("S1: the contractor's ABN changing between preview and apply changes MatchBasis, and so the fingerprint", () => {
  const preview = planImport("suppliers", parseCsv(csv), refs("51824753556"));
  const apply = planImport("suppliers", parseCsv(csv), refs("99999999999"));
  expect(preview.rows[0].matchBasis).toBe("abn");
  expect(apply.rows[0].matchBasis).toBe("manual");
  expect(apply.hash).not.toBe(preview.hash);
});

it("S3: an exported name that starts with '=' comes back from a re-import unchanged", () => {
  const exported = toCsv(["supplier_name"], [["=ACME"], ["+61 8 8000 0000"], ["it's fine"]]);
  expect(parseCsv(exported).rows.map((row) => row.cells.supplier_name)).toEqual(["=ACME", "+61 8 8000 0000", "it's fine"]);
});
