/// <reference types="jest" />

// A guard-only caller (the lab's probes, plan M5) may answer D9's test-record
// question itself, so a synthetic probe needs no database read. The rules it
// answers stay the guard's: a test record is still refused, a write that names
// nothing is still refused, and myobRequest, the only path that can reach
// MYOB, never passes a lookup, so it always uses D9's.

jest.mock("./db", () => ({ closeConnection: jest.fn(), createServiceRequestConnection: jest.fn(), executeQuery: jest.fn() }));
jest.mock("./myob-controls", () => ({ assertMyobControlsAllow: jest.fn().mockResolvedValue(undefined) }));

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { todayInDarwin } from "./darwinDate";
import { MyobRequestRefusedError } from "./myob-errors";
import { guardMyobRequest } from "./myob-request-guard";
import { TestDataEgressError } from "./test-data";

const db = require("./db") as Record<string, jest.Mock>;
const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const WRITE = { body: JSON.stringify({ Date: `${todayInDarwin()}T00:00:00` }), method: "POST" as const, url: `https://api.myob.com/accountright/${CF}/Purchase/Order/Service` };
const saved = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...saved, MYOB_WRITES_ENABLED: "true" };
});
afterAll(() => {
  process.env = saved;
});

describe("guardMyobRequest with a caller's test-record lookup", () => {
  it("uses it instead of the database, and still refuses a test record or a write that names nothing", async () => {
    await expect(guardMyobRequest(WRITE, new Date(), { testRecords: async () => ({ isTest: true, named: true }) })).rejects.toBeInstanceOf(TestDataEgressError);
    await expect(guardMyobRequest(WRITE, new Date(), { testRecords: async () => ({ isTest: false, named: false }) })).rejects.toMatchObject({ code: "no_record" });
    await expect(guardMyobRequest(WRITE, new Date(), { testRecords: async () => ({ isTest: false, named: true }) })).resolves.toMatchObject({ operation: "orders.create" });
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
  });

  it("without one, a write that names nothing is refused as D9 has it", async () => {
    await expect(guardMyobRequest(WRITE)).rejects.toEqual(expect.any(MyobRequestRefusedError));
    await expect(guardMyobRequest(WRITE)).rejects.toMatchObject({ code: "no_record" });
  });
});

describe("only the lab's probes pass a lookup", () => {
  const src = join(__dirname);
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
    });
  const callers = files(src)
    .map((path) => ({ name: relative(src, path), text: readFileSync(path, "utf8").replace(/\/\/[^\n]*/g, "") }))
    .filter((file) => /\bguardMyobRequest\(/.test(file.text) && file.name !== "myob-request-guard.ts");

  it("myobRequest calls the guard with the request alone, and the probes are the only other caller", () => {
    expect(callers.map((file) => file.name).sort()).toEqual(["myob-api-log.ts", join("myob", "lab", "probes.ts")]);
    const apiLog = callers.find((file) => file.name === "myob-api-log.ts")!.text;
    expect(apiLog).toMatch(/guardMyobRequest\(\{[^()]*\}\);/);
  });
});
