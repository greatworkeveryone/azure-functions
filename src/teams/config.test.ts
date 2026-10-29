import { teamsAlertsReadiness } from "./config";

const WORKFLOW = { TEAMS_WORKFLOW_KEY: "k", TEAMS_WORKFLOW_WEBHOOK_URL: "https://flow.example/invoke" };

describe("teamsAlertsReadiness", () => {
  it("has no problem while alerts are off, whatever is missing", () => {
    expect(teamsAlertsReadiness({})).toEqual({ mode: "off", problem: null, route: "workflows" });
    expect(teamsAlertsReadiness({ TEAMS_ALERTS_ROUTE: "app" }).problem).toBeNull();
  });

  it("names the missing flow settings when the workflows route is live", () => {
    const readiness = teamsAlertsReadiness({ TEAMS_ALERTS_ENABLED: "true", TEAMS_WORKFLOW_KEY: "k" });
    expect(readiness.problem).toBe("TEAMS_WORKFLOW_WEBHOOK_URL or TEAMS_WORKFLOW_KEY is unset");
  });

  it("is ready when the workflows route is live and configured", () => {
    expect(teamsAlertsReadiness({ TEAMS_ALERTS_ENABLED: "true", ...WORKFLOW }).problem).toBeNull();
  });

  it("does not need the flow settings for a dry run", () => {
    expect(teamsAlertsReadiness({ TEAMS_ALERTS_DRY_RUN: "true" })).toEqual({ mode: "dry-run", problem: null, route: "workflows" });
  });

  it("names the missing app id when the app route is on", () => {
    expect(teamsAlertsReadiness({ TEAMS_ALERTS_ENABLED: "true", TEAMS_ALERTS_ROUTE: "app" }).problem).toBe("TEAMS_APP_ID is unset");
    expect(teamsAlertsReadiness({ TEAMS_ALERTS_ENABLED: "true", TEAMS_ALERTS_ROUTE: "app", TEAMS_APP_ID: "id" }).problem).toBeNull();
  });
});
