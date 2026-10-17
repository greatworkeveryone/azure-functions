/// <reference types="jest" />
import { ADMIN_KIND, CONTRACTOR_FLOW_KINDS, JOB_KINDS, jobKindOf, runsContractorFlow } from "../jobKinds";

describe("job kinds", () => {
  it("are the three the frontend knows, in the order it lists them", () => {
    expect([...JOB_KINDS]).toEqual(["facilities", "maintenance", "admin"]);
    expect(ADMIN_KIND).toBe("admin");
  });

  it("put facilities and maintenance on the contractor flow by name, and admin off it", () => {
    expect([...CONTRACTOR_FLOW_KINDS]).toEqual(["facilities", "maintenance"]);
    expect(runsContractorFlow("facilities")).toBe(true);
    expect(runsContractorFlow("maintenance")).toBe(true);
    expect(runsContractorFlow("admin")).toBe(false);
  });

  it("give a kind nobody listed no contractor flow, whatever it is", () => {
    for (const kind of ["projects", "Admin", "Facilities", "plumbing"]) expect(runsContractorFlow(kind)).toBe(false);
  });

  it("read a missing or blank kind as facilities, like the column's default", () => {
    for (const missing of [undefined, null, "", "   ", 3, {}]) {
      expect(jobKindOf(missing)).toBe("facilities");
      expect(runsContractorFlow(missing)).toBe(true);
    }
    expect(jobKindOf(" admin ")).toBe("admin");
  });
});
