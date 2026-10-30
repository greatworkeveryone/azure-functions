/// <reference types="jest" />
// TR6 switches: defaults keep today's behaviour, the client refuses what the
// switches forbid, and the attachment-cleanup rule is positive and coupled to push.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  currentSwitches,
  mayDeleteLocalFileForUpstreamCopy,
  mayPullWorkRequests,
  mayPushWorkRequests,
  pushEnabled,
  syncMode,
} from "./mybuildingsSwitches";

describe("switch values", () => {
  it("default to normal with push on", () => {
    expect(syncMode({})).toBe("normal");
    expect(pushEnabled({})).toBe(true);
    expect(mayPullWorkRequests({})).toBe(true);
    expect(mayPushWorkRequests({})).toBe(true);
  });

  it("only the exact word false turns push off", () => {
    expect(pushEnabled({ MYBUILDINGS_PUSH_ENABLED: "false" })).toBe(false);
    expect(pushEnabled({ MYBUILDINGS_PUSH_ENABLED: " FALSE " })).toBe(false);
    expect(pushEnabled({ MYBUILDINGS_PUSH_ENABLED: "true" })).toBe(true);
    expect(pushEnabled({ MYBUILDINGS_PUSH_ENABLED: "0" })).toBe(true);
  });

  it("read_only pulls but never pushes; off does neither", () => {
    expect(currentSwitches({ MYBUILDINGS_SYNC_MODE: "read_only" })).toMatchObject({ mayPull: true, mayPush: false });
    expect(currentSwitches({ MYBUILDINGS_SYNC_MODE: "off" })).toMatchObject({ mayPull: false, mayPush: false });
    expect(mayPushWorkRequests({ MYBUILDINGS_PUSH_ENABLED: "false" })).toBe(false);
  });

  it("an unrecognised mode fails safe to off", () => {
    expect(syncMode({ MYBUILDINGS_SYNC_MODE: "readonly" })).toBe("off");
  });
});

describe("local file deletion on the strength of an upstream copy", () => {
  const confirmed = { MyBuildingsConfirmedAt: new Date() };
  it("needs a recorded copy AND push enabled", () => {
    expect(mayDeleteLocalFileForUpstreamCopy(confirmed, {})).toBe(true);
    expect(mayDeleteLocalFileForUpstreamCopy({ MyBuildingsConfirmedAt: null }, {})).toBe(false);
    expect(mayDeleteLocalFileForUpstreamCopy({}, {})).toBe(false);
    expect(mayDeleteLocalFileForUpstreamCopy(confirmed, { MYBUILDINGS_PUSH_ENABLED: "false" })).toBe(false);
    expect(mayDeleteLocalFileForUpstreamCopy(confirmed, { MYBUILDINGS_SYNC_MODE: "read_only" })).toBe(false);
  });

  it("no cleanupAttachments function or timer exists on this branch (F25)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && /cleanupAttachments/.test(readFileSync(abs, "utf8")) && !/removed/i.test(readFileSync(abs, "utf8"))) hits.push(abs);
      }
    };
    walk(join(__dirname, ".."));
    expect(hits).toEqual([]);
  });
});

describe("client backstop", () => {
  const OLD = { ...process.env };
  const fetchMock = jest.fn();
  beforeEach(() => {
    jest.resetModules();
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ Data: { WorkRequests: [] } }) });
    (global as any).fetch = fetchMock;
    process.env.MYBUILDINGS_API_URL = "https://api.example.test";
    process.env.MYBUILDINGS_BEARER_TOKEN = "t";
  });
  afterEach(() => { process.env = { ...OLD }; });

  it("calls nothing in work-request API when the mode is off", async () => {
    process.env.MYBUILDINGS_SYNC_MODE = "off";
    const client = require("../mybuildings-client");
    await expect(client.fetchWorkRequests("")).rejects.toThrow(/sync is off/);
    await expect(client.fetchWorkRequestById(1)).rejects.toThrow(/sync is off/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads but never writes in read_only", async () => {
    process.env.MYBUILDINGS_SYNC_MODE = "read_only";
    const client = require("../mybuildings-client");
    await client.fetchWorkRequests("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(client.createWorkRequest({})).rejects.toThrow(/switched off/);
    await expect(client.bulkStatusUpdate([])).rejects.toThrow(/switched off/);
    await expect(client.uploadAttachment({ isTest: false }, { Attachment_Name: "a", Attachment_URL: "u" })).rejects.toThrow(/switched off/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("push false blocks writes but not reads", async () => {
    process.env.MYBUILDINGS_PUSH_ENABLED = "false";
    const client = require("../mybuildings-client");
    await client.fetchWorkRequests("");
    await expect(client.createWorkRequest({})).rejects.toThrow(/switched off/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("changes nothing by default", async () => {
    const client = require("../mybuildings-client");
    await client.createWorkRequest({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to download from another host", async () => {
    const client = require("../mybuildings-client");
    await expect(client.downloadAttachmentBytes("https://evil.example.test/a.png")).rejects.toThrow(/not the myBuildings API host/);
  });
});
