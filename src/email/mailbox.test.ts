/// <reference types="jest" />
import { activeMailboxSetting, incomingMailbox, mailboxConfigError } from "./mailbox";

const KEYS = ["GRAPH_MAILBOX_ACTIVE", "GRAPH_MAILBOX_DEV", "GRAPH_MAILBOX_PROD"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.GRAPH_MAILBOX_DEV = "floorplan-dev@example.test";
  process.env.GRAPH_MAILBOX_PROD = "floorplan@example.test";
  delete process.env.GRAPH_MAILBOX_ACTIVE;
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("incomingMailbox", () => {
  it("defaults to the dev mailbox when the switch is unset", () => {
    expect(activeMailboxSetting()).toBe("GRAPH_MAILBOX_DEV");
    expect(incomingMailbox()).toBe("floorplan-dev@example.test");
  });

  it("reads the dev mailbox when set to dev", () => {
    process.env.GRAPH_MAILBOX_ACTIVE = "dev";
    expect(incomingMailbox()).toBe("floorplan-dev@example.test");
  });

  it("reads the prod mailbox when set to prod, ignoring case and whitespace", () => {
    process.env.GRAPH_MAILBOX_ACTIVE = " Prod ";
    expect(activeMailboxSetting()).toBe("GRAPH_MAILBOX_PROD");
    expect(incomingMailbox()).toBe("floorplan@example.test");
  });

  it("returns null for an unknown switch value instead of guessing", () => {
    process.env.GRAPH_MAILBOX_ACTIVE = "production";
    expect(activeMailboxSetting()).toBeNull();
    expect(incomingMailbox()).toBeNull();
    expect(mailboxConfigError()).toContain('must be "dev" or "prod"');
  });

  it("returns null when the selected mailbox is blank, and names that setting", () => {
    process.env.GRAPH_MAILBOX_ACTIVE = "prod";
    process.env.GRAPH_MAILBOX_PROD = "  ";
    expect(incomingMailbox()).toBeNull();
    expect(mailboxConfigError()).toBe("GRAPH_MAILBOX_PROD not configured");
  });
});
