import { inboundColumnsOn, noticesMailbox, readInboundConfig } from "./config";

jest.mock("../email/mailbox", () => ({ incomingMailbox: jest.fn(() => "Ops@Randazzo.Properties") }));

describe("readInboundConfig", () => {
  it("is off and empty by default, so nothing about mail changes until a setting is made", () => {
    const config = readInboundConfig({});
    expect(config).toMatchObject({ dryRun: false, enabled: false, extraMailboxes: [], ignored: [], inactivityDays: 7, maxAgeDays: 3, maxPerRun: 25 });
    expect(inboundColumnsOn(config)).toBe(false);
  });

  it("is on only for the exact string true", () => {
    expect(readInboundConfig({ INBOUND_TRIAGE_ENABLED: "true" }).enabled).toBe(true);
    for (const value of ["TRUE", "1", "yes", " true", ""]) expect(readInboundConfig({ INBOUND_TRIAGE_ENABLED: value }).enabled).toBe(false);
    expect(readInboundConfig({ INBOUND_TRIAGE_DRY_RUN: "true" }).dryRun).toBe(true);
  });

  it("reads extra mailboxes: trimmed, lower case, once each, never the main mailbox, bad entries ignored and named", () => {
    const config = readInboundConfig({ INBOUND_EXTRA_MAILBOXES: " Accounts@randazzo.properties, facilities@randazzo.properties ,accounts@randazzo.properties, ops@randazzo.properties, not-an-address, ,x@y" });
    expect(config.extraMailboxes).toEqual(["accounts@randazzo.properties", "facilities@randazzo.properties"]);
    expect(config.ignored).toEqual(["not-an-address", "x@y"]);
    expect(inboundColumnsOn(config)).toBe(true);
  });

  it("triages notices@ and any listed mailbox, notices first", () => {
    const config = readInboundConfig({ INBOUND_TRIAGE_MAILBOXES: "accounts@randazzo.properties,notices@randazzo.properties" });
    expect(config.triageMailboxes).toEqual(["notices@randazzo.properties", "accounts@randazzo.properties"]);
  });

  it("writes the new columns when triage, its dry run or an extra mailbox is set", () => {
    expect(inboundColumnsOn(readInboundConfig({ INBOUND_TRIAGE_ENABLED: "true" }))).toBe(true);
    expect(inboundColumnsOn(readInboundConfig({ INBOUND_TRIAGE_DRY_RUN: "true" }))).toBe(true);
    expect(inboundColumnsOn(readInboundConfig({ INBOUND_TRIAGE_MAILBOXES: "a@b.co" }))).toBe(false);
  });

  it("takes whole numbers in range and falls back to the default for anything else", () => {
    expect(readInboundConfig({ INBOUND_TRIAGE_INACTIVITY_DAYS: "14", INBOUND_TRIAGE_MAX_AGE_DAYS: "10", INBOUND_TRIAGE_MAX_PER_RUN: "50" })).toMatchObject({ inactivityDays: 14, maxAgeDays: 10, maxPerRun: 50 });
    expect(readInboundConfig({ INBOUND_TRIAGE_INACTIVITY_DAYS: "0", INBOUND_TRIAGE_MAX_AGE_DAYS: "abc", INBOUND_TRIAGE_MAX_PER_RUN: "9999" })).toMatchObject({ inactivityDays: 7, maxAgeDays: 3, maxPerRun: 25 });
  });
});

describe("noticesMailbox", () => {
  it("is the decided address unless a setting says otherwise, and prefers the sending address to the default", () => {
    expect(noticesMailbox({})).toBe("notices@randazzo.properties");
    expect(noticesMailbox({ COMMS_FROM_ADDRESS: "Notices@Other.example" })).toBe("notices@other.example");
    expect(noticesMailbox({ COMMS_FROM_ADDRESS: "Notices@Other.example", INBOUND_NOTICES_MAILBOX: "in@x.example" })).toBe("in@x.example");
    expect(noticesMailbox({ COMMS_FROM_ADDRESS: "not an address" })).toBe("notices@randazzo.properties");
  });
});
