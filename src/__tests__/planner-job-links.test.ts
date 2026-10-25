// PL1 drift guard: Planner tasks and director-approval emails both deep-link to
// a job. The web app has no /jobs/:id route, so both must use the same
// `/jobs?jobId={id}` query-param format — if one changes without the other, a
// link in Planner (or an inbox) starts 404ing again.

jest.mock("../graph", () => ({ graphSendMail: jest.fn() }));

import { buildJobUrl } from "../email/director-emails";
import { jobLink } from "../plannerHelpers";

describe("job deep links", () => {
  const originalBaseUrl = process.env.APP_BASE_URL;

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = originalBaseUrl;
  });

  it("Planner tasks and director emails build the identical link", () => {
    process.env.APP_BASE_URL = "https://floorplan.example.com";
    expect(jobLink(process.env.APP_BASE_URL, 4821)).toBe(buildJobUrl(4821));
    expect(buildJobUrl(4821)).toBe("https://floorplan.example.com/jobs?jobId=4821");
  });

  it("agrees even when APP_BASE_URL carries a trailing slash", () => {
    process.env.APP_BASE_URL = "https://floorplan.example.com/";
    expect(jobLink(process.env.APP_BASE_URL, 7)).toBe(buildJobUrl(7));
  });

  it("agrees on the step and record too (J6)", () => {
    process.env.APP_BASE_URL = "https://floorplan.example.com";
    const target = { quoteId: 3, step: "quotes" } as const;
    expect(jobLink(process.env.APP_BASE_URL, 7, target)).toBe(buildJobUrl(7, target));
    expect(buildJobUrl(7, target)).toBe("https://floorplan.example.com/jobs?jobId=7&step=quotes&quoteId=3");
  });
});
