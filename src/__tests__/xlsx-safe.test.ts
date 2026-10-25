/// <reference types="jest" />
import { deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { IMPORT_HEADERS, readImportRows } from "../serviceScheduleImport";
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

// Review F2 (17 Oct): the guard walked only the entries the end record declares, and JSZip reads
// every central entry it finds. Setting the declared count to 0 passed the guard and let a 206 KB
// upload inflate to 427 MB. The directory must hold exactly what the end record says, and end
// exactly where the end record starts.
const UNREADABLE = "That file isn't a readable .xlsx spreadsheet";

function endAt(buffer: Buffer): number {
  for (let at = buffer.length - 22; at >= 0; at -= 1) if (buffer.readUInt32LE(at) === 0x06054b50) return at;
  throw new Error("no end record");
}

function withEnd(buffer: Buffer, change: (end: Buffer) => void): Buffer {
  const out = Buffer.from(buffer);
  change(out.subarray(endAt(out)));
  return out;
}

const small = () => zip([{ data: Buffer.from("<a/>"), name: "a.xml" }, { data: Buffer.from("<b/>"), name: "b.xml" }]);

it("refuses a zip whose end record says 0 entries but whose directory holds some (review F2 finding 1)", () => {
  const bomb = withEnd(zip([{ data: Buffer.alloc(60 * 1024 * 1024, 0x20), name: "xl/worksheets/sheet1.xml" }]), (end) => {
    end.writeUInt16LE(0, 8);
    end.writeUInt16LE(0, 10);
  });
  expect(() => assertSafeXlsx(bomb)).toThrow(XlsxRejectedError);
  expect(() => assertSafeXlsx(bomb)).toThrow(UNREADABLE);
});

it("refuses a directory with more entries than the end record declares", () => {
  const understated = withEnd(small(), (end) => {
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
  });
  expect(() => assertSafeXlsx(understated)).toThrow(UNREADABLE);
});

it("refuses when this disk's entry count differs from the total", () => {
  const split = withEnd(small(), (end) => end.writeUInt16LE(1, 8));
  expect(() => assertSafeXlsx(split)).toThrow(UNREADABLE);
});

it("refuses a directory that doesn't end where the end record starts", () => {
  const wrongSize = withEnd(small(), (end) => end.writeUInt32LE(end.readUInt32LE(12) - 1, 12));
  expect(() => assertSafeXlsx(wrongSize)).toThrow(UNREADABLE);
  const wrongOffset = withEnd(small(), (end) => end.writeUInt32LE(end.readUInt32LE(16) + 1, 16));
  expect(() => assertSafeXlsx(wrongOffset)).toThrow(UNREADABLE);
  const real = small();
  const gap = Buffer.concat([real.subarray(0, endAt(real)), Buffer.alloc(10), real.subarray(endAt(real))]);
  expect(() => assertSafeXlsx(gap)).toThrow(UNREADABLE);
});

it("refuses bytes in front of the zip, which shift every offset JSZip reads", () => {
  expect(() => assertSafeXlsx(Buffer.concat([Buffer.alloc(100, 0x41), small()]))).toThrow(UNREADABLE);
});

it("still lets an honest small zip through", () => {
  expect(() => assertSafeXlsx(small())).not.toThrow();
});

async function paddedWorkbook(megabytes: number): Promise<Buffer> {
  // exceljs ships jszip; reading and rewriting its zip here needs no dependency of our own.
  const JSZip = require("jszip");
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Schedules").addRow(["Building"]);
  const archive = await JSZip.loadAsync(Buffer.from(await wb.xlsx.writeBuffer()));
  const name = Object.keys(archive.files).find((file) => /worksheets\/sheet1\.xml$/.test(file)) as string;
  const xml = Buffer.from(await archive.file(name).async("string"));
  const cut = xml.indexOf("</worksheet>");
  archive.file(name, Buffer.concat([xml.subarray(0, cut), Buffer.alloc(megabytes * 1024 * 1024, 0x20), xml.subarray(cut)]));
  return archive.generateAsync({ compression: "DEFLATE", compressionOptions: { level: 9 }, type: "nodebuffer" });
}

describe("the import path with the count-0 bomb", () => {
  jest.setTimeout(120000);

  const bombWorkbook = async () =>
    withEnd(await paddedWorkbook(100), (end) => {
      end.writeUInt16LE(0, 8);
      end.writeUInt16LE(0, 10);
    });

  it("is refused before ExcelJS inflates it: a small upload doesn't grow the process", async () => {
    const bomb = await bombWorkbook();
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);
    let outcome: unknown;
    try {
      outcome = await readImportRows(bomb).then(
        () => "read",
        (error: unknown) => error,
      );
    } finally {
      clearInterval(timer);
    }
    peak = Math.max(peak, process.memoryUsage().rss);
    expect(outcome).toBeInstanceOf(XlsxRejectedError);
    expect((peak - before) / 1048576).toBeLessThan(64);
  });
});

describe("the schedule import's own, lower unpack cap (review F2 finding 11)", () => {
  jest.setTimeout(120000);

  it("reads a full 2,000-row import", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Schedules");
    sheet.addRow([...IMPORT_HEADERS]);
    for (let row = 0; row < 2000; row += 1) {
      sheet.addRow(["Tower A", "", `Fire pump ${row}`, "Fire safety", "Level 3 plant room, east riser", "Safe Fire Pty Ltd", "Y", 6, "months", "28/04/2026", 14, "", "Quarterly test and inspection"]);
    }
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    expect(buffer.length).toBeLessThan(10 * 1024 * 1024);
    expect(await readImportRows(buffer)).toHaveLength(2000);
  });

  it("refuses a workbook that unpacks past about 8 MB, which the general 50 MB cap would let through", async () => {
    const heavy = await paddedWorkbook(9);
    expect(() => assertSafeXlsx(heavy)).not.toThrow();
    await expect(readImportRows(heavy)).rejects.toThrow("The spreadsheet is too large once unpacked");
  });
});
