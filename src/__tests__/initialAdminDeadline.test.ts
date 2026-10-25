import { initialAdminDeadline } from "../initialAdminDeadline";
it.each([["Critical", "2026-10-21"], ["High", "2026-10-23"], ["Normal", "2026-10-26"], ["Low", "2026-11-02"]])("sets %s from the Darwin day across UTC midnight", (priority, expected) => {
  expect(initialAdminDeadline(priority, new Date("2026-10-18T16:00:00Z"))).toBe(expected);
});
