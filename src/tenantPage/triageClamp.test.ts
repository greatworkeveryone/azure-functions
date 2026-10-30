/// <reference types="jest" />
jest.mock("../ai/config", () => ({ isConfigured: () => true, readAiConfig: () => ({}) }));
jest.mock("../ai/runAi", () => ({ runAi: jest.fn() }));

import { suggestTriage } from "./triage";

const runAi = (require("../ai/runAi") as { runAi: jest.Mock }).runAi;

describe("the AI can raise the urgency but never lower it", () => {
  it("keeps the tenant's emergency when the model says routine", async () => {
    runAi.mockResolvedValue({ ok: true, output: { category: "plumbing", urgency: "routine" } });
    const t = await suggestTriage("water coming through the ceiling", { category: "plumbing", urgency: "emergency" });
    expect(t).toMatchObject({ source: "ai", urgency: "emergency" });
  });
  it("keeps the rules' emergency read from the words when the tenant chose routine", async () => {
    runAi.mockResolvedValue({ ok: true, output: { category: "electrical", urgency: "routine" } });
    expect((await suggestTriage("sparks from the power point", { category: "other", urgency: "routine" })).urgency).toBe("emergency");
  });
  it("lets the model raise routine to urgent", async () => {
    runAi.mockResolvedValue({ ok: true, output: { category: "other", urgency: "urgent" } });
    expect((await suggestTriage("the door sticks a bit", { category: "other", urgency: "routine" })).urgency).toBe("urgent");
  });
});
