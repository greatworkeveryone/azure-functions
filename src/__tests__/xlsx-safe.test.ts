/// <reference types="jest" />
import { deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { assertSafeXlsx, XlsxRejectedError } from "../xlsx-safe";

type Entry = { data: Buffer; method?: 0 | 8; name: string };

/** A minimal zip: local headers, central directory, end record. Sizes are true. */
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

it("lets a real workbook through", async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Schedules").addRow(["Building"]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  expect(() => assertSafeXlsx(buffer)).not.toThrow();
});

it("refuses a high-ratio entry before anything is unpacked in full (code review 2)", () => {
  const bomb = zip([{ data: Buffer.alloc(60 * 1024 * 1024, 0x20), name: "xl/worksheets/sheet1.xml" }]);
  expect(bomb.length).toBeLessThan(200 * 1024);
  expect(() => assertSafeXlsx(bomb)).toThrow(XlsxRejectedError);
  expect(() => assertSafeXlsx(bomb)).toThrow("The spreadsheet is too large once unpacked");
});

it("refuses when the entries add up past the total cap, even if each is small", () => {
  const parts = Array.from({ length: 6 }, (_, i) => ({ data: Buffer.alloc(10 * 1024 * 1024, 0x20), name: `xl/part${i}.xml` }));
  expect(() => assertSafeXlsx(zip(parts), { maxEntries: 50, maxEntryBytes: 20 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024 })).toThrow(
    "The spreadsheet is too large once unpacked",
  );
});

it("doesn't trust declared sizes: a stored entry is counted by its real length", () => {
  const stored = zip([{ data: Buffer.alloc(2 * 1024 * 1024, 0x41), method: 0, name: "big.bin" }]);
  expect(() => assertSafeXlsx(stored, { maxEntries: 10, maxEntryBytes: 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024 })).toThrow(XlsxRejectedError);
});

it("refuses too many entries and anything that isn't a zip", () => {
  const many = zip(Array.from({ length: 5 }, (_, i) => ({ data: Buffer.from("x"), name: `f${i}` })));
  expect(() => assertSafeXlsx(many, { maxEntries: 4, maxEntryBytes: 1024, maxTotalBytes: 4096 })).toThrow(XlsxRejectedError);
  expect(() => assertSafeXlsx(Buffer.from("not a spreadsheet"))).toThrow("That file isn't a readable .xlsx spreadsheet");
});
