import { ackDelivery } from "./delivery";

describe("ackDelivery", () => {
  it("is none for a request told another way and null when never acknowledged", () => {
    expect(ackDelivery("other", null, null, "live")).toBe("none");
    expect(ackDelivery(null, null, null, "live")).toBeNull();
  });
  it("reports the real outcome, not just that an email was queued", () => {
    expect(ackDelivery("email", "sent", "sent", "live")).toBe("sent");
    expect(ackDelivery("email", "would_send", "sent", "live")).toBe("dry_run");
    expect(ackDelivery("email", "failed", "failed", "live")).toBe("failed");
    expect(ackDelivery("email", "queued", "awaiting_approval", "live")).toBe("waiting_approval");
  });
  it("a queued email follows the send mode", () => {
    expect(ackDelivery("email", "queued", "queued", "live")).toBe("queued");
    expect(ackDelivery("email", "queued", "queued", "dry-run")).toBe("dry_run");
    expect(ackDelivery("email", "queued", "queued", "off")).toBe("off");
  });
});
