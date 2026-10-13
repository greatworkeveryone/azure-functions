/// <reference types="jest" />
import { DECISIONS_CSV_HEADERS, decisionsCsvFileName, decisionsToCsv } from "./csv";
import type { DecisionRow } from "./rows";

function row(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    action: "approval_limit.change",
    actor: { kind: "user", name: "Ada Admin", role: "admin", userId: 3 },
    after: { maxApprovalAmount: 5000 },
    attributedTo: null,
    before: { maxApprovalAmount: 1000 },
    buildingId: null,
    computed: null,
    correlationId: "6f9619ff-8b86-d011-b42d-00c04fc964ff",
    financialImpact: null,
    isException: true,
    jobId: null,
    ledgerId: 41,
    occurredAt: "2026-10-13T14:29:00.000Z", // 23:59 on 13 October in Darwin
    reason: null,
    ruleApplied: null,
    subjectId: "accounts",
    subjectType: "approval_limit",
    tenantId: null,
    ...overrides,
  };
}

/** Splits CSV text into records of cells, honouring quotes (enough for these fixtures). */
function parse(csv: string): string[][] {
  const records: string[][] = [];
  let cell = "";
  let current: string[] = [];
  let quoted = false;
  const body = csv.replace(/^﻿/, "");
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      current.push(cell);
      cell = "";
    } else if (ch === "\r" && body[i + 1] === "\n") {
      current.push(cell);
      records.push(current);
      current = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  return records;
}

const col = (name: (typeof DECISIONS_CSV_HEADERS)[number]) => DECISIONS_CSV_HEADERS.indexOf(name);

describe("decisionsToCsv", () => {
  it("opens with a byte order mark so Excel reads it as UTF-8, then a header row", () => {
    const csv = decisionsToCsv([row()]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.replace("﻿", "").split("\r\n")[0]).toBe(DECISIONS_CSV_HEADERS.join(","));
  });

  it("ends every line with CRLF, header-only for no rows", () => {
    expect(decisionsToCsv([]).replace("﻿", "")).toBe(`${DECISIONS_CSV_HEADERS.join(",")}\r\n`);
    expect(decisionsToCsv([row(), row()]).split("\r\n")).toHaveLength(4);
  });

  it("names the attribution columns", () => {
    expect(DECISIONS_CSV_HEADERS).toContain("Attributed to");
    expect(DECISIONS_CSV_HEADERS).toContain("Attributed role");
  });

  it("writes the date as DD/MM/YYYY HH:mm in Darwin time", () => {
    const [, cells] = parse(decisionsToCsv([row()]));
    expect(cells[col("Date (Darwin)")]).toBe("13/10/2026 23:59");
    const next = parse(decisionsToCsv([row({ occurredAt: "2026-10-13T14:30:00.000Z" })]))[1];
    expect(next[col("Date (Darwin)")]).toBe("14/10/2026 00:00");
  });

  it("has one cell per header on every record", () => {
    const records = parse(decisionsToCsv([row(), row({ reason: 'Said "no", twice\nthen yes', financialImpact: 12 })]));
    for (const r of records) expect(r).toHaveLength(DECISIONS_CSV_HEADERS.length);
  });

  it("fills the columns from the row", () => {
    const cells = parse(
      decisionsToCsv([
        row({
          action: "quote.approve_attributed",
          attributedTo: { name: "Mo Manager", role: "facilities_manager", userId: 12 },
          buildingId: 5,
          financialImpact: 1234.5,
          isException: false,
          jobId: 99,
          reason: "Talked it through on site",
          ruleApplied: "within_own_limit",
          subjectId: "123",
          subjectType: "quote",
          tenantId: 42,
        }),
      ]),
    )[1];

    expect(cells[col("Ledger ID")]).toBe("41");
    expect(cells[col("Action")]).toBe("quote.approve_attributed");
    expect(cells[col("Subject type")]).toBe("quote");
    expect(cells[col("Subject ID")]).toBe("123");
    expect(cells[col("Tenancy ID")]).toBe("42");
    expect(cells[col("Job ID")]).toBe("99");
    expect(cells[col("Building ID")]).toBe("5");
    expect(cells[col("Actor")]).toBe("Ada Admin");
    expect(cells[col("Actor role")]).toBe("admin");
    expect(cells[col("Actor type")]).toBe("user");
    expect(cells[col("Attributed to")]).toBe("Mo Manager");
    expect(cells[col("Attributed role")]).toBe("facilities_manager");
    expect(cells[col("Reason")]).toBe("Talked it through on site");
    expect(cells[col("Financial impact (AUD)")]).toBe("1234.50");
    expect(cells[col("Rule applied")]).toBe("within_own_limit");
    expect(cells[col("Exception")]).toBe("No");
    expect(cells[col("Correlation ID")]).toBe("6f9619ff-8b86-d011-b42d-00c04fc964ff");
  });

  it("leaves absent values empty and flags exceptions", () => {
    const cells = parse(decisionsToCsv([row({ actor: { kind: "system", name: "ledgerTimer", role: null, userId: null } })]))[1];
    expect(cells[col("Tenancy ID")]).toBe("");
    expect(cells[col("Attributed to")]).toBe("");
    expect(cells[col("Actor role")]).toBe("");
    expect(cells[col("Financial impact (AUD)")]).toBe("");
    expect(cells[col("Computed")]).toBe("");
    expect(cells[col("Actor type")]).toBe("system");
    expect(cells[col("Exception")]).toBe("Yes");
  });

  it("carries the snapshots as JSON text in one cell each", () => {
    const cells = parse(decisionsToCsv([row({ computed: { suggested: 3, list: [1, 2] } })]))[1];
    expect(JSON.parse(cells[col("Before")])).toEqual({ maxApprovalAmount: 1000 });
    expect(JSON.parse(cells[col("After")])).toEqual({ maxApprovalAmount: 5000 });
    expect(JSON.parse(cells[col("Computed")])).toEqual({ suggested: 3, list: [1, 2] });
  });

  it("quotes commas, quotes and line breaks so a reason can't break the columns", () => {
    const reason = 'He said "no", then\nchanged his mind';
    const cells = parse(decisionsToCsv([row({ reason })]))[1];
    expect(cells[col("Reason")]).toBe(reason);
  });

  it("keeps accented names intact", () => {
    const cells = parse(decisionsToCsv([row({ actor: { kind: "user", name: "José Müller", role: "director", userId: 8 } })]))[1];
    expect(cells[col("Actor")]).toBe("José Müller");
  });

  it("defuses spreadsheet formulas typed into free text", () => {
    for (const evil of ["=HYPERLINK(\"http://x\",\"y\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd"]) {
      const cells = parse(decisionsToCsv([row({ reason: evil })]))[1];
      expect(cells[col("Reason")]).toBe(`'${evil}`);
    }
    const names = parse(decisionsToCsv([row({ actor: { kind: "user", name: "=cmd|' /C calc'!A0", role: "admin", userId: 1 } })]))[1];
    expect(names[col("Actor")].startsWith("'=")).toBe(true);
  });

  it("does not mangle a negative impact: that is our own number, not free text", () => {
    const cells = parse(decisionsToCsv([row({ financialImpact: -250 })]))[1];
    expect(cells[col("Financial impact (AUD)")]).toBe("-250.00");
  });
});

describe("decisionsCsvFileName", () => {
  it("is decisions-YYYYMMDD.csv by the Darwin calendar", () => {
    expect(decisionsCsvFileName(new Date("2026-10-13T02:00:00Z"))).toBe("decisions-20261013.csv");
    expect(decisionsCsvFileName(new Date("2026-10-13T15:00:00Z"))).toBe("decisions-20261014.csv");
  });
});
