import { approvalThreshold, commsMode, footerAddress, fromAddress, fromName, maxPerMinute } from "./config";

describe("commsMode", () => {
  it.each([
    [{}, "off"],
    [{ COMMS_SEND_ENABLED: "TRUE" }, "off"],
    [{ COMMS_SEND_ENABLED: "1" }, "off"],
    [{ COMMS_SEND_ENABLED: "true" }, "live"],
    [{ COMMS_SEND_DRY_RUN: "true" }, "dry-run"],
    [{ COMMS_SEND_ENABLED: "true", COMMS_SEND_DRY_RUN: "true" }, "dry-run"],
    [{ COMMS_SEND_DRY_RUN: "yes" }, "off"],
  ])("%j -> %s", (env, expected) => {
    expect(commsMode(env as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe("the numbers and addresses", () => {
  it("defaults to 25 a minute and a threshold of 20", () => {
    expect(maxPerMinute({})).toBe(25);
    expect(approvalThreshold({})).toBe(20);
  });

  it("takes a whole number in range and ignores anything else", () => {
    expect(maxPerMinute({ COMMS_MAX_PER_MINUTE: "10" } as NodeJS.ProcessEnv)).toBe(10);
    for (const bad of ["0", "-3", "2.5", "abc", "", "1000"]) expect(maxPerMinute({ COMMS_MAX_PER_MINUTE: bad } as NodeJS.ProcessEnv)).toBe(25);
    expect(approvalThreshold({ COMMS_APPROVAL_THRESHOLD: "0" } as NodeJS.ProcessEnv)).toBe(0);
    expect(approvalThreshold({ COMMS_APPROVAL_THRESHOLD: "x" } as NodeJS.ProcessEnv)).toBe(20);
  });

  it("sends from notices@ as Randazzo Properties unless told otherwise", () => {
    expect(fromAddress({})).toBe("notices@randazzo.properties");
    expect(fromName({})).toBe("Randazzo Properties");
    expect(fromAddress({ COMMS_FROM_ADDRESS: " other@randazzo.properties " } as NodeJS.ProcessEnv)).toBe("other@randazzo.properties");
    expect(footerAddress({})).toBe("GPO Box 551, Darwin NT 0801");
    expect(footerAddress({ COMMS_FOOTER_ADDRESS: "1 Example St" } as NodeJS.ProcessEnv)).toBe("1 Example St");
  });
});
