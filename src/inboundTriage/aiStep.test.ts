import { runAi, readAiConfig } from "../ai";
import { aiTriageAvailable, readWithAi, TRIAGE_PURPOSE } from "./aiStep";
import { rulesWork } from "./workInference";

jest.mock("../ai", () => ({ readAiConfig: jest.fn(), runAi: jest.fn() }));

const config = jest.mocked(readAiConfig);
const run = jest.mocked(runAi);
const fallback = rulesWork("Hello", "Nothing");

const reading = { buildingName: "Frogmore House", category: "Lifts", intent: "maintenance_request" as const, jobNumber: 12, tenancyName: null, urgency: "high" as const };
const okMeta = { callId: 1, correlationId: "c", latencyMs: 1, model: "mock", promptVersion: "inbound_email_triage@1", provider: "mock", purpose: TRIAGE_PURPOSE, redactionCount: 0, throttled: false };

const aiConfig = (over: Record<string, unknown>) => ({ enabled: true, enabledPurposes: [TRIAGE_PURPOSE], ...over }) as ReturnType<typeof readAiConfig>;

beforeEach(() => {
  jest.clearAllMocks();
  config.mockReturnValue(aiConfig({}));
});

describe("the AI step", () => {
  it("is only asked when the gateway is on and the purpose is listed", async () => {
    config.mockReturnValue(aiConfig({ enabled: false }));
    expect(aiTriageAvailable()).toBe(false);
    expect(await readWithAi(1, "s", "b", fallback)).toBeNull();
    config.mockReturnValue(aiConfig({ enabledPurposes: ["echo_test"] }));
    expect(aiTriageAvailable()).toBe(false);
    expect(await readWithAi(1, "s", "b", fallback)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("calls the gateway as the system with the subject and body only, and folds the answer into a Work", async () => {
    run.mockResolvedValue({ meta: okMeta, ok: true, output: reading });
    const work = await readWithAi(5, "Lift is out", "Please fix the lift", fallback);
    expect(work).toEqual({ buildingName: "Frogmore House", category: "Lifts", intent: "maintenance_request", jobNumber: 12, lane: "facilities", source: "ai", tenancyName: null, urgency: "high" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({ kind: "system", userId: null }),
      input: "Subject: Lift is out\nBody:\nPlease fix the lift",
      purpose: "inbound_email_triage",
      recordId: "5",
      recordType: "email",
    }));
  });

  it("keeps the keyword category and urgency when the model gives none, and drops a category for a non-maintenance email", async () => {
    const rules = rulesWork("Leak", "water leaking from the ceiling asap");
    run.mockResolvedValue({ meta: okMeta, ok: true, output: { ...reading, category: null, intent: "maintenance_request", urgency: null } });
    expect(await readWithAi(1, "s", "b", rules)).toMatchObject({ category: "Hydraulic", urgency: "high" });
    run.mockResolvedValue({ meta: okMeta, ok: true, output: { ...reading, category: "Lifts", intent: "invoice_or_quote" } });
    expect(await readWithAi(1, "s", "b", rules)).toMatchObject({ category: null, lane: "accounts" });
  });

  it("leaves the keyword reading in place when the gateway refuses", async () => {
    run.mockResolvedValue({ meta: okMeta, ok: false, refusal: { code: "invalid_output", message: "x" } });
    expect(await readWithAi(1, "s", "b", fallback)).toBeNull();
  });
});
