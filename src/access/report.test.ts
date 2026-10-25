jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({ conn: true }),
  executeQuery: jest.fn(),
}));
jest.mock("../graph", () => ({ graphSendMail: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@azure/functions", () => ({ app: { timer: jest.fn() } }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), flush: jest.fn().mockResolvedValue(true) } }));

import { buildAnomalyReport, formatAnomalyReport, sendAnomalyReport } from "./report";

const db = jest.requireMock("../db") as Record<string, jest.Mock>;
const graph = jest.requireMock("../graph") as { graphSendMail: jest.Mock };

const SINCE = new Date("2026-10-14T21:30:00Z");
const row = (overrides: Record<string, unknown> = {}) => ({
  Anomaly: "new_country",
  At: new Date("2026-10-15T01:14:00Z"),
  Country: "US",
  DisplayName: "Jane Smith",
  Kind: "signin",
  LocalHour: 10,
  Role: "accounts",
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DEV_EMAIL_OVERRIDE;
  process.env.APP_BASE_URL = "https://floorplan.example";
  db.createServiceRequestConnection.mockResolvedValue({ conn: true });
});

describe("formatAnomalyReport", () => {
  it("is null when nothing happened", () => {
    expect(formatAnomalyReport([], SINCE)).toBeNull();
  });

  it("keeps names out of the subject and lists each event in Darwin time", () => {
    const report = formatAnomalyReport(
      [row(), row({ Anomaly: "outside_window", Kind: "money", LocalHour: 2 }), row({ Anomaly: "burst" })],
      SINCE,
    );
    expect(report?.subject).toBe("Floorplan: 3 unusual access events to review");
    expect(report?.subject).not.toMatch(/Jane/);
    expect(report?.body).toContain("since 15/10/2026 07:00 (Darwin time)");
    expect(report?.body).toContain("- 15/10/2026 10:44 · Jane Smith (accounts) · used Floorplan from US");
    expect(report?.body).toContain("a money action out of hours (about 02:00 their time)");
    expect(report?.body).toContain("more than 300 requests in 5 minutes");
    expect(report?.body).toContain("https://floorplan.example/admin");
  });

  it("caps the list", () => {
    const report = formatAnomalyReport(Array.from({ length: 55 }, () => row()), SINCE);
    expect(report?.body).toContain("- and 5 more");
  });
});

describe("buildAnomalyReport", () => {
  it("reads only anomalies since the given time and closes its own connection", async () => {
    db.executeQuery.mockResolvedValueOnce([row()]);
    const report = await buildAnomalyReport(SINCE);
    expect(report?.count).toBe(1);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toMatch(/Anomaly <> N'none'/);
    expect(params[0]).toMatchObject({ name: "Since", value: SINCE });
    expect(db.closeConnection).toHaveBeenCalledWith({ conn: true });
  });
});

describe("sendAnomalyReport", () => {
  const NOW = new Date("2026-10-15T21:30:00Z");

  it("sends nothing when there is nothing to report", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    await expect(sendAnomalyReport(NOW)).resolves.toEqual({ count: 0, recipients: 0, sent: false });
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("emails active admin and CFO users", async () => {
    db.executeQuery.mockResolvedValueOnce([row()]).mockResolvedValueOnce([{ Email: "ada@rp.example" }, { Email: "jo@rp.example" }]);
    await expect(sendAnomalyReport(NOW)).resolves.toEqual({ count: 1, recipients: 2, sent: true });
    expect(db.executeQuery.mock.calls[1][1]).toMatch(/Role IN \(N'admin', N'cfo'\)/);
    expect(graph.graphSendMail).toHaveBeenCalledWith("not-a-record", ["ada@rp.example", "jo@rp.example"], expect.any(String), expect.any(String));
  });

  it("honours DEV_EMAIL_OVERRIDE", async () => {
    process.env.DEV_EMAIL_OVERRIDE = "dev@gwe.example";
    db.executeQuery.mockResolvedValueOnce([row()]).mockResolvedValueOnce([{ Email: "ada@rp.example" }, { Email: "jo@rp.example" }]);
    await sendAnomalyReport(NOW);
    expect(graph.graphSendMail.mock.calls[0][1]).toEqual(["dev@gwe.example"]);
  });
});

describe("accessReportTimer registration", () => {
  afterEach(() => {
    delete process.env.ACCESS_REPORT_ENABLED;
    jest.resetModules();
  });

  it("is always registered, and the body sends nothing unless ACCESS_REPORT_ENABLED is exactly true", async () => {
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(() => {
        (async () => {
          const { app } = jest.requireMock("@azure/functions") as { app: { timer: jest.Mock } };
          app.timer.mockClear();
          process.env.ACCESS_REPORT_ENABLED = "yes";
          const mod = require("../functions/accessReportTimer") as { accessReportTimer: (t: unknown, c: unknown) => Promise<void> };
          expect(app.timer).toHaveBeenCalledWith("accessReportTimer", expect.objectContaining({ schedule: "0 30 21 * * *" }));
          const log = jest.fn();
          await mod.accessReportTimer({} as never, { log, error: jest.fn() } as never);
          expect(log).toHaveBeenCalledWith(expect.stringContaining("ACCESS_REPORT_ENABLED=true"));
          expect(graph.graphSendMail).not.toHaveBeenCalled();
        })().then(resolve, reject);
      });
    });
  });

  it("runs daily at 07:00 Darwin when enabled", () => {
    jest.isolateModules(() => {
      const { app } = jest.requireMock("@azure/functions") as { app: { timer: jest.Mock } };
      app.timer.mockClear();
      process.env.ACCESS_REPORT_ENABLED = "true";
      require("../functions/accessReportTimer");
      expect(app.timer).toHaveBeenCalledWith("accessReportTimer", expect.objectContaining({ schedule: "0 30 21 * * *" }));
    });
  });
});
