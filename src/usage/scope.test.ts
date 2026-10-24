/// <reference types="jest" />
import { AppRole } from "../auth";
import { ACTION_ROLES } from "../action-roles";
import { FINANCE_MODULE_KEYS, FINANCE_USER_ROLES, isFinanceUserRole, usageScopeFor } from "./scope";

describe("usageScopeFor", () => {
  it("gives admin and directors everything, the CFO the finance view, and nobody else anything", () => {
    expect(usageScopeFor([AppRole.ADMIN])).toBe("all");
    expect(usageScopeFor([AppRole.DIRECTOR])).toBe("all");
    expect(usageScopeFor([AppRole.CFO])).toBe("finance");
    for (const role of [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.USER]) expect(usageScopeFor([role])).toBeNull();
    expect(usageScopeFor([])).toBeNull();
  });

  it("keeps the wider scope for someone holding the CFO role and a director's", () => {
    expect(usageScopeFor([AppRole.CFO, AppRole.DIRECTOR])).toBe("all");
  });
});

describe("the finance scope", () => {
  it("is accounts, accounts_manager, cfo and admin people, and nobody from facilities", () => {
    expect([...FINANCE_USER_ROLES].sort()).toEqual(["accounts", "accounts_manager", "admin", "cfo"]);
    for (const role of ["facilities", "facilities_manager", "director", "user", "", null, undefined]) expect(isFinanceUserRole(role)).toBe(false);
    expect(isFinanceUserRole("Accounts")).toBe(true);
  });

  it("reports time in finance pages only, with no facilities module", () => {
    expect(FINANCE_MODULE_KEYS).toEqual(["finance", "finance/controls", "admin/myob", "payroll", "timesheets"]);
  });
});

describe("the capabilities", () => {
  it("name who may see what: admin and directors, the CFO (with them through the hierarchy), admin only for the controls", () => {
    expect(ACTION_ROLES.viewUsageAnalytics.gate).toEqual([AppRole.ADMIN, AppRole.DIRECTOR]);
    expect(ACTION_ROLES.viewFinanceUsageAnalytics.gate).toEqual([AppRole.CFO]);
    expect(ACTION_ROLES.manageUsageAnalytics.gate).toEqual([AppRole.ADMIN]);
  });
});
