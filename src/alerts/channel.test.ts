/// <reference types="jest" />
import { resolveAlertChannels, teamsChannel } from "./channel";
import type { Alert } from "./channel";
import { NOT_A_RECORD } from "../test-data";

const ALERT: Alert = { egress: NOT_A_RECORD, previewText: "Floorplan: urgent item needs you", route: "/jobs?jobId=12", text: "Open it." };
const ENV_LIVE = { TEAMS_ALERTS_ENABLED: "true", TEAMS_APP_ID: "app-1" } as NodeJS.ProcessEnv;

describe("resolveAlertChannels", () => {
  it("has teams when alerts are live or dry-run and the app id is set", () => {
    expect(resolveAlertChannels(ENV_LIVE).map((c) => c.name)).toEqual(["teams"]);
    expect(resolveAlertChannels({ TEAMS_ALERTS_DRY_RUN: "true", TEAMS_APP_ID: "app-1" } as NodeJS.ProcessEnv)).toHaveLength(1);
  });

  it("has none when the mode is off or TEAMS_APP_ID is missing", () => {
    expect(resolveAlertChannels({ TEAMS_APP_ID: "app-1" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(resolveAlertChannels({ TEAMS_ALERTS_ENABLED: "true" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(resolveAlertChannels({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("teamsChannel", () => {
  const send = (status: number) =>
    teamsChannel({
      env: ENV_LIVE,
      fetch: jest.fn().mockResolvedValue({ headers: new Headers(), ok: status < 300, status, text: async () => "denied" }) as unknown as typeof fetch,
      getToken: async () => "tok",
    }).send({ entraOid: "oid-1" }, ALERT);

  it("reports sent on a 204", async () => {
    await expect(send(204)).resolves.toEqual({ detail: null, status: "sent" });
  });

  it("passes the typed failure and its error text through", async () => {
    await expect(send(404)).resolves.toEqual({ detail: "denied", status: "no_user" });
  });

  it("reports dry_run without sending", async () => {
    const fetchMock = jest.fn();
    const channel = teamsChannel({ env: { TEAMS_ALERTS_DRY_RUN: "true", TEAMS_APP_ID: "app-1" } as NodeJS.ProcessEnv, fetch: fetchMock, log: jest.fn() });
    await expect(channel.send({ entraOid: "oid-1" }, ALERT)).resolves.toMatchObject({ status: "dry_run" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
