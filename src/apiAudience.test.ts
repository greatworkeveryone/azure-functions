import { acceptedAudiences, apiAudienceMode, audienceConfigProblem } from "./apiAudience";

const CLIENT = "96a734cd-3a84-44fe-a6d4-edcbb44f17cc";
const SQL = ["https://database.windows.net/", "https://database.windows.net"];
const APP = [CLIENT, `api://${CLIENT}`];

describe("apiAudienceMode", () => {
  it.each([[undefined, "sql"], ["", "sql"], ["sql", "sql"], ["both", "both"], ["api", "api"], [" API ", "api"], ["bogus", "sql"]])(
    "maps %p to %s",
    (value, mode) => {
      expect(apiAudienceMode({ API_TOKEN_AUDIENCE: value })).toBe(mode);
    },
  );
});

describe("acceptedAudiences", () => {
  it("defaults to the SQL forms only", () => {
    expect(acceptedAudiences({ APP_CLIENT_ID: CLIENT })).toEqual(SQL);
  });

  it("both: SQL forms plus app audiences", () => {
    expect(acceptedAudiences({ API_TOKEN_AUDIENCE: "both", APP_CLIENT_ID: CLIENT })).toEqual([...SQL, ...APP]);
  });

  it("api: app audiences only", () => {
    expect(acceptedAudiences({ API_TOKEN_AUDIENCE: "api", APP_CLIENT_ID: CLIENT })).toEqual(APP);
  });

  it("adds an explicit URI override", () => {
    expect(
      acceptedAudiences({ API_TOKEN_AUDIENCE: "api", API_TOKEN_AUDIENCE_URI: "api://floorplan", APP_CLIENT_ID: CLIENT }),
    ).toEqual([...APP, "api://floorplan"]);
  });

  it("api without any app audience falls back to SQL rather than accepting nothing-or-everything", () => {
    expect(acceptedAudiences({ API_TOKEN_AUDIENCE: "api" })).toEqual(SQL);
  });

  it("both without an app audience is the SQL forms", () => {
    expect(acceptedAudiences({ API_TOKEN_AUDIENCE: "both" })).toEqual(SQL);
  });
});

describe("audienceConfigProblem", () => {
  it("is null for valid combinations", () => {
    expect(audienceConfigProblem({})).toBeNull();
    expect(audienceConfigProblem({ API_TOKEN_AUDIENCE: "both", APP_CLIENT_ID: CLIENT, SQL_USER_CONNECTION: "true" })).toBeNull();
    expect(audienceConfigProblem({ API_TOKEN_AUDIENCE: "api", APP_CLIENT_ID: CLIENT })).toBeNull();
  });

  it("flags api with the SQL user connection lever", () => {
    expect(audienceConfigProblem({ API_TOKEN_AUDIENCE: "api", APP_CLIENT_ID: CLIENT, SQL_USER_CONNECTION: "true" })).toMatch(
      /SQL_USER_CONNECTION/,
    );
  });

  it("flags an unknown value", () => {
    expect(audienceConfigProblem({ API_TOKEN_AUDIENCE: "bogus" })).toMatch(/sql, both, api/);
  });

  it("flags api/both with no APP_CLIENT_ID", () => {
    expect(audienceConfigProblem({ API_TOKEN_AUDIENCE: "api" })).toMatch(/APP_CLIENT_ID/);
    expect(audienceConfigProblem({ API_TOKEN_AUDIENCE: "both" })).toMatch(/APP_CLIENT_ID/);
  });
});
