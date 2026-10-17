import { hasLeaseEventWithin, optionNoticeDate } from "./tenancyLeaseEvents";

const TODAY = "2026-10-14";

describe("optionNoticeDate", () => {
  it("is the expiry less the notice months", () => {
    expect(optionNoticeDate({ expiry: "2027-01-14", optionNoticeMonths: 3 })).toBe("2026-10-14");
  });

  it("clamps to the end of a shorter month instead of rolling into the next", () => {
    expect(optionNoticeDate({ expiry: "2026-05-31", optionNoticeMonths: 3 })).toBe("2026-02-28");
    expect(optionNoticeDate({ expiry: "2028-05-31", optionNoticeMonths: 3 })).toBe("2028-02-29");
  });

  it("is undefined without an expiry or a notice period", () => {
    expect(optionNoticeDate({ optionNoticeMonths: 3 })).toBeUndefined();
    expect(optionNoticeDate({ expiry: "2027-01-14" })).toBeUndefined();
    expect(optionNoticeDate({ expiry: "2027-01-14", optionNoticeMonths: undefined })).toBeUndefined();
  });
});

describe("hasLeaseEventWithin", () => {
  it("is true when the lease expires inside the window, including today and the last day", () => {
    expect(hasLeaseEventWithin({ expiry: "2026-10-14" }, TODAY, 90)).toBe(true);
    expect(hasLeaseEventWithin({ expiry: "2026-11-28" }, TODAY, 90)).toBe(true);
    expect(hasLeaseEventWithin({ expiry: "2027-01-12" }, TODAY, 90)).toBe(true);
  });

  it("is false when the expiry is past or beyond the window", () => {
    expect(hasLeaseEventWithin({ expiry: "2026-10-13" }, TODAY, 90)).toBe(false);
    expect(hasLeaseEventWithin({ expiry: "2027-01-13" }, TODAY, 90)).toBe(false);
  });

  it("is true when the option deadline falls inside the window even though the expiry is later", () => {
    const tenant = { expiry: "2027-04-30", optionNoticeMonths: 6 };
    expect(optionNoticeDate(tenant)).toBe("2026-10-30");
    expect(hasLeaseEventWithin(tenant, TODAY, 90)).toBe(true);
  });

  it("is false when the option deadline has already passed and the expiry is far off", () => {
    expect(hasLeaseEventWithin({ expiry: "2027-04-30", optionNoticeMonths: 12 }, TODAY, 90)).toBe(false);
  });

  it("is false with no expiry", () => {
    expect(hasLeaseEventWithin({}, TODAY, 90)).toBe(false);
  });
});
