import { approvalDecision } from "./queueJob";

describe("approvalDecision", () => {
  it("lets a small send to records through", () => {
    expect(approvalDecision(3, 0, 20).reason).toBeNull();
  });

  it("holds a send over the threshold", () => {
    expect(approvalDecision(21, 0, 20).reason).toBe("size");
  });

  it("holds a send that takes the last 24 hours over the threshold", () => {
    expect(approvalDecision(5, 18, 20).reason).toBe("recent");
  });

  it("holds any send with a typed address, and says why", () => {
    const one = approvalDecision(1, 0, 20, 1);
    expect(one.reason).toBe("typed");
    expect(one.note).toContain("One address was typed in");
    expect(approvalDecision(4, 0, 20, 2).note).toContain("2 addresses were typed in");
  });
});
