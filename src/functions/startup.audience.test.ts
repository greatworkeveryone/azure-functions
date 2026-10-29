// M7: startup refuses to boot when API_TOKEN_AUDIENCE=api meets SQL_USER_CONNECTION=true.
jest.mock("@azure/functions", () => ({ app: { hook: { appStart: jest.fn(), postInvocation: jest.fn() }, http: jest.fn() } }));
jest.mock("../migrate", () => ({ checkMigrations: jest.fn(), runMigrations: jest.fn(), startupMigrationMode: jest.fn() }));
jest.mock("../migrate-cli", () => ({ resolveMigrationTarget: jest.fn() }));
jest.mock("../db", () => ({ createServiceRequestConnection: jest.fn() }));
jest.mock("../sentry", () => ({ initSentry: jest.fn(), Sentry: {} }));

const SAVED = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED };
  jest.resetModules();
});

function boot(): void {
  jest.isolateModules(() => {
    require("./startup");
  });
}

describe("startup audience guard", () => {
  it("refuses api + SQL_USER_CONNECTION=true", () => {
    process.env.API_TOKEN_AUDIENCE = "api";
    process.env.APP_CLIENT_ID = "client";
    process.env.SQL_USER_CONNECTION = "true";
    expect(boot).toThrow(/SQL_USER_CONNECTION/);
  });

  it("boots with both + SQL_USER_CONNECTION=true", () => {
    process.env.API_TOKEN_AUDIENCE = "both";
    process.env.APP_CLIENT_ID = "client";
    process.env.SQL_USER_CONNECTION = "true";
    expect(boot).not.toThrow();
  });

  it("boots with the default", () => {
    delete process.env.API_TOKEN_AUDIENCE;
    expect(boot).not.toThrow();
  });
});
