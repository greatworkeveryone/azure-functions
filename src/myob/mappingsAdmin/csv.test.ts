/// <reference types="jest" />

import { CsvError, parseCsv, toCsv } from "./csv";

describe("parseCsv", () => {
  it("reads a header and rows by column name, with quotes, commas, doubled quotes, CRLF and a BOM", () => {
    const text = '﻿company_file_id,Supplier Name,abn\r\n0f9e,"ACME, ""Air"" Pty",51 824 753 556\r\n\r\nabc,Plain,\n';
    expect(parseCsv(text)).toEqual({
      header: ["company_file_id", "supplier_name", "abn"],
      rows: [
        { cells: { abn: "51 824 753 556", company_file_id: "0f9e", supplier_name: 'ACME, "Air" Pty' }, line: 2 },
        { cells: { abn: "", company_file_id: "abc", supplier_name: "Plain" }, line: 4 },
      ],
    });
  });

  it("keeps a quoted line break inside one cell", () => {
    expect(parseCsv('a,b\n"one\ntwo",x\n').rows[0].cells).toEqual({ a: "one\ntwo", b: "x" });
  });

  it.each([
    ["an empty file", ""],
    ["a header only", "a,b\n"],
    ["an unclosed quote", 'a,b\n"x,y\n'],
    ["a repeated column", "a,a\n1,2\n"],
  ])("refuses %s", (_label, text) => {
    expect(() => parseCsv(text)).toThrow(CsvError);
  });

  it("refuses more than 2,000 rows", () => {
    expect(() => parseCsv(`a\n${"x\n".repeat(2000)}`)).not.toThrow();
    expect(() => parseCsv(`a\n${"x\n".repeat(2001)}`)).toThrow(/2,000 rows/);
  });
});

describe("toCsv", () => {
  it("quotes what needs quoting and defuses spreadsheet formulas", () => {
    expect(toCsv(["a", "b"], [["x,y", 'say "hi"'], ["=SUM(A1)", "+1"], ["-2", "@cmd"]])).toBe(
      'a,b\r\n"x,y","say ""hi"""\r\n\'=SUM(A1),\'+1\r\n\'-2,\'@cmd\r\n',
    );
  });
});
