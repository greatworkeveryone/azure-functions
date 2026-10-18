// Who can do what: one table (beta sprint J4, WP43).
//
// Every job action's requireRole reads its allowlist from here, and every other
// capability the frontend checks names the backend allowlist it mirrors. The
// table is exported as JSON (`npm run export-roles` → exports/action-roles.json)
// and the frontend reads that file as its CAPABILITY_ROLES, so a button is
// offered to exactly the roles the server lets through. Parity is tested in
// both repos: here, every route listed is called once per role and must admit
// at least the exported roles and at most the gate's (action-roles.parity.test);
// the JSON must equal this table, and its hash is pinned in both repos.
//
// An entry's `gate` is the allowlist requireRole is given, so requireRole's
// hierarchy applies (admin passes every gate, director every non-admin one, cfo
// any accounts gate, the managers their team's). `match: "exact"` marks a list
// a handler checks literally instead. `refused` are roles the gate admits but
// the handler then turns away, with the reason: the frontend never offers them
// the action. `conditional` are roles the gate admits that the handler lets
// through only when its own condition holds (an attributed approval, package
// 117): like `refused` they are left out of the export and the parity sweep's
// "must pass" list, but the sweep accepts them past the gate. Such an action is
// offered to them through a capability of its own (approveQuoteAttributed).

import { AppRole, rolesPassGate } from "./auth";
import { ATTRIBUTED_APPROVAL_ROLES, SUBJECT_ELIGIBLE_ROLES } from "./approvalAuthority";
import {
  ARCHIVE_ASSETS_ROLES,
  EDIT_ASSETS_ROLES,
  MANAGE_ASSET_TYPES_ROLES,
  VERIFY_ASSETS_ROLES,
  VIEW_ASSETS_ROLES,
} from "./assetRegister";
import { MANAGE_DEFECTS_PERIODS_ROLES, MANAGE_SERVICE_SCHEDULES_ROLES, VIEW_FACILITIES_ROLES } from "./facilitiesRoles";
import { ASK_FOR_DECISION_ROLES, COMPLETE_NEXT_STEP_ROLES, MANAGER_AND_ABOVE_ROLES, RESPOND_TO_DECISION_ROLES } from "./jobDecisions/roles";
import { FLAG_ROLES } from "./jobTransitionGuard";
import { CHECKIN_KEYS_ROLES, CHECKOUT_KEYS_ROLES } from "./keyRoles";

export interface ActionRoles {
  /** The allowlist the handler's gate is given. */
  gate: readonly AppRole[];
  /** "hierarchy" (default): requireRole's hierarchy applies. "exact": the handler checks these roles literally. */
  match?: "exact" | "hierarchy";
  /** Roles the gate admits that the handler then refuses. */
  refused?: readonly AppRole[];
  /** Roles the gate admits that the handler lets through only on its own condition: not exported. */
  conditional?: readonly AppRole[];
  /** The routes whose role gate is exactly this entry (swept by the parity test). */
  routes: readonly string[];
  /** Why, in a sentence: what the action is and any refusal. */
  why: string;
}

const A = AppRole;
const roles = (list: readonly string[]): readonly AppRole[] => list as readonly AppRole[];

// Job actions: the handlers named in `routes` read these gates directly.
const JOB_EDIT: readonly AppRole[] = [A.ADMIN, A.DIRECTOR, A.FACILITIES, A.FACILITIES_APPROVAL, A.ACCOUNTS, A.ACCOUNTS_APPROVAL];
const JOB_READ: readonly AppRole[] = JOB_EDIT;
const TENANCY_DESK: readonly AppRole[] = [A.ACCOUNTS, A.ACCOUNTS_APPROVAL, A.ADMIN, A.DIRECTOR];
const REVIEW_APPROVERS: readonly AppRole[] = [A.ACCOUNTS_APPROVAL, A.CFO, A.DIRECTOR];
const ADMIN_TEST_ONLY = "admin acts on test records only (beta sprint decision 4), and a screen doesn't know whether a record is one";

export const ACTION_ROLES = {
  addQuoteContractor: {
    gate: [A.ACCOUNTS, A.FACILITIES],
    routes: ["addJobRequestedContractor", "removeJobRequestedContractor", "toggleRequestedContractorSent"],
    why: "Request quotes: keep a job's list of contractors asked to quote. Field officers do this (decision 1).",
  },
  approveInvoice: {
    gate: roles(SUBJECT_ELIGIBLE_ROLES.invoice),
    refused: [A.ADMIN],
    routes: ["approveJobInvoice"],
    why: `Stage-1 approval of an invoice: the approval-authority core's eligible roles (J1); ${ADMIN_TEST_ONLY}.`,
  },
  approveInvoiceAsDirector: {
    gate: [A.DIRECTOR],
    refused: [A.ADMIN],
    routes: ["directorApproveJobInvoice", "undoDirectorApproveJobInvoice"],
    why: "The director's approval of an invoice, and undoing it. The handler re-checks the director role: admin is never a director approver.",
  },
  approveOwnRentReview: {
    gate: [A.DIRECTOR],
    match: "exact",
    routes: [],
    why: "Approve a rent review you prepared: directors are never blocked by separation of duties (decision 17).",
  },
  approveProcedures: {
    gate: [A.DIRECTOR],
    routes: ["publishProcedure"],
    why: "Publish a procedure, which stamps the approval onto that version.",
  },
  // Package 117 (attributed approval) adds the attributed roles to this gate and
  // lists them as `conditional`, so they pass the gate without being offered the
  // plain approval; approveQuoteAttributed is what offers it to them.
  approveQuote: {
    gate: roles([...SUBJECT_ELIGIBLE_ROLES.quote, ...ATTRIBUTED_APPROVAL_ROLES.quote]),
    // The gate admits these only while ATTRIBUTED_APPROVAL_ENABLED="true"
    // (src/attributedApproval.ts unlessHeldOff); held off, decisions 1 and 9.
    conditional: [A.FACILITIES],
    refused: [A.ADMIN],
    routes: ["approveQuote"],
    why: `Approve (or send up for approval) a selected quote: the approval-authority core's eligible roles (J1); ${ADMIN_TEST_ONLY}.`,
  },
  approveQuoteAttributed: {
    gate: roles(ATTRIBUTED_APPROVAL_ROLES.quote),
    match: "exact",
    routes: [],
    why: "Approve a quote within your own limit by naming the manager it was agreed with (ATTRIBUTED_APPROVAL_ROLES). Its route is approveQuote, where plain facilities is conditional and held off unless ATTRIBUTED_APPROVAL_ENABLED is \"true\".",
  },
  approveQuoteAsDirector: {
    gate: [A.DIRECTOR],
    refused: [A.ADMIN],
    routes: ["directorApproveQuote"],
    why: "The director's approval of a quote. The handler re-checks the director role: admin is never a director approver.",
  },
  approveRentReview: {
    gate: REVIEW_APPROVERS,
    refused: [A.ADMIN],
    routes: ["approveRentReview", "returnRentReview"],
    why: "Approve a rent review, or return it to its preparer (REVIEW_APPROVE_ROLES). Admin is never an approver (D20).",
  },
  approveTimesheets: {
    gate: [A.ADMIN, A.DIRECTOR, A.FACILITIES_APPROVAL, A.ACCOUNTS_APPROVAL],
    match: "exact",
    routes: ["approveTimesheet"],
    why: "Approve timesheets (isApprovalManager, timesheets.ts: a literal role check).",
  },
  archiveAnyJob: {
    gate: [A.ADMIN, A.DIRECTOR, A.FACILITIES_APPROVAL, A.ACCOUNTS_APPROVAL],
    match: "exact",
    // Swept with a job someone else created (action-roles.parity.test PROBES):
    // the gate is editJobs, this list decides who archives a job that isn't theirs.
    routes: ["archiveJob"],
    why: "Archive any job (ARCHIVE_ANY_JOB_ROLES, a literal check in archiveJob). Plain facilities archive only their own.",
  },
  archiveAssets: {
    gate: ARCHIVE_ASSETS_ROLES,
    routes: ["archiveAsset"],
    why: "Archive and restore an asset.",
  },
  archiveTenancy: {
    gate: [A.ACCOUNTS_APPROVAL],
    routes: ["archiveTenant", "unarchiveTenant"],
    why: "Archive or restore a tenancy (TENANCY_ARCHIVE_ROLES).",
  },
  askForDecision: {
    gate: ASK_FOR_DECISION_ROLES,
    routes: ["requestJobDecision", "withdrawJobDecisionRequest"],
    why: "Ask people for a decision on an Admin / Accounts job, and take the question back.",
  },
  bulkCreateKeys: {
    gate: [A.ADMIN, A.DIRECTOR, A.FACILITIES_APPROVAL],
    routes: ["bulkImportKeys"],
    why: "Import keys from a spreadsheet (BULK_CREATE_ROLES, keys.ts).",
  },
  checkinKeys: {
    gate: CHECKIN_KEYS_ROLES,
    routes: ["checkinKeys"],
    why: "Put keys back. Field officers do this (decision 1).",
  },
  checkoutKeys: {
    gate: CHECKOUT_KEYS_ROLES,
    routes: ["checkoutKeys", "uploadKeySignature"],
    why: "Take keys out and keep the signature. Field officers do this (decision 1).",
  },
  commenceRentReview: {
    gate: TENANCY_DESK,
    routes: ["commenceRentReview", "updateRentReviewBasis", "calculateRentReview"],
    why: "Commence, re-base and calculate a rent review (TENANCY_EDIT_ROLES).",
  },
  completeAnyNextStep: {
    gate: roles(MANAGER_AND_ABOVE_ROLES),
    match: "exact",
    routes: [],
    why: "Mark any job's next step done, not only your own (MANAGER_AND_ABOVE_ROLES, checked literally in completeJobNextStep's standing rule).",
  },
  completeNextStep: {
    gate: COMPLETE_NEXT_STEP_ROLES,
    routes: ["completeJobNextStep"],
    why: "Mark a decision's next step done: the roles that can be asked; the step's owner, or a manager and above (completeAnyNextStep), then decide.",
  },
  completePurchaseOrder: {
    gate: [A.ACCOUNTS_APPROVAL, A.FACILITIES],
    routes: ["markPurchaseOrderComplete"],
    why: "Mark the work on a purchase order complete. Field officers do this (decision 1).",
  },
  createInvoice: {
    gate: [A.ACCOUNTS, A.FACILITIES],
    routes: ["upsertJobInvoice"],
    why: "Add or edit an invoice. Field officers add the invoices they receive (decision 1); approving one is approveInvoice.",
  },
  createPurchaseOrder: {
    gate: [A.ACCOUNTS, A.FACILITIES_APPROVAL],
    routes: ["upsertPurchaseOrder"],
    why: "Raise or edit a purchase order (it rests on an approved quote).",
  },
  createQuote: {
    gate: [A.ACCOUNTS, A.FACILITIES],
    routes: ["upsertQuote"],
    why: "Add or edit a received quote. Field officers do this (decision 1); approving one is approveQuote.",
  },
  createTestData: {
    gate: [A.ADMIN, A.DIRECTOR],
    match: "exact",
    routes: [],
    why: "Create a record marked as test data (D9). It gates the create forms' test checkbox; the rule itself lives inside the creates (test-data.ts testFlagForCreate, a literal admin-or-director check), so no route of its own.",
  },
  deleteAnyInspection: {
    gate: [A.ADMIN, A.DIRECTOR, A.FACILITIES, A.FACILITIES_APPROVAL],
    refused: [A.FACILITIES],
    routes: ["deleteInspection"],
    why: "Delete any inspection. Plain facilities delete only their own (deleteInspection's own-row rule).",
  },
  deleteInvoice: {
    gate: [A.ACCOUNTS_APPROVAL],
    routes: ["deleteJobInvoice"],
    why: "Delete an invoice nothing has relied on yet.",
  },
  deleteTenancyRegisterRows: {
    gate: TENANCY_DESK,
    routes: ["deleteRegisterTenant", "deleteTenant"],
    why: "Delete a tenancy register row that is still an empty draft: locked, checked and ledgered (TENANCY_DELETE_ROLES, deleteTenancyDraft).",
  },
  editAnyRentReview: {
    gate: [A.ACCOUNTS_APPROVAL, A.ADMIN, A.DIRECTOR],
    routes: ["cancelRentReview"],
    why: "Act on a rent review someone else owns, and cancel one (REVIEW_CANCEL_ROLES; isManagerOrAbove).",
  },
  editAssets: {
    gate: EDIT_ASSETS_ROLES,
    routes: ["upsertAsset", "uploadAssetAttachment", "upsertLocation"],
    why: "Create and edit assets and locations, and upload their files.",
  },
  editInspections: {
    gate: [A.ADMIN, A.DIRECTOR, A.FACILITIES, A.FACILITIES_APPROVAL],
    routes: ["createInspection", "applyInspectionOps", "completeInspection", "uploadInspectionAttachment", "raiseJobsFromInspection"],
    why: "Create, edit and complete inspections (EDIT_INSPECTIONS_ROLES, inspections.ts).",
  },
  editJobs: {
    gate: JOB_EDIT,
    routes: ["upsertJob", "addJobEvent", "archiveJob", "unarchiveJob"],
    why: "Create and edit jobs, add their history and move them on (the transition guard has the last word).",
  },
  editKeys: {
    gate: [A.ADMIN, A.DIRECTOR, A.FACILITIES, A.FACILITIES_APPROVAL],
    routes: ["createKey", "updateKey", "deleteKey", "restoreKey", "reportKeyLost", "uploadKeyPhoto"],
    why: "Keep the key register (EDIT_KEYS_ROLES, keys.ts).",
  },
  editProcedures: {
    gate: [A.FACILITIES_APPROVAL, A.ACCOUNTS_APPROVAL],
    routes: ["saveProcedureDraft"],
    why: "Write procedure drafts (EDITOR_GATE, procedures.ts).",
  },
  editTenancy: {
    gate: TENANCY_DESK,
    routes: ["upsertRegisterTenant", "upsertOccupancy", "upsertCarpark", "upsertMiscFee", "upsertTenantIncentive", "upsertLeaseAdministration"],
    why: "Edit the tenancy register and a tenant's detail.",
  },
  hardDeleteTenancyRows: {
    gate: [A.ADMIN],
    routes: ["deleteOccupancy", "deleteCarpark"],
    why: "Delete an occupancy or carpark row outright: admin only, as before J4. A hard delete with no archive, ledger or relied-on check; becomes an archive in lane D.",
  },
  manageAccessProfiles: {
    gate: [A.ADMIN],
    routes: ["getAccessProfiles", "setAccessProfile"],
    why: "Edit a person's expected-use access profile (ACCESS_MANAGE_ROLES).",
  },
  manageAssetTypes: {
    gate: MANAGE_ASSET_TYPES_ROLES,
    routes: ["upsertAssetType"],
    why: "Add and retire asset types.",
  },
  manageDefectsPeriods: {
    gate: MANAGE_DEFECTS_PERIODS_ROLES,
    routes: ["upsertDefectsPeriod", "archiveDefectsPeriod"],
    why: "Add, edit and archive defects periods, and book inside one with a reason.",
  },
  managePurchaseOrders: {
    gate: [A.ACCOUNTS_APPROVAL, A.FACILITIES_APPROVAL],
    routes: ["deletePurchaseOrder", "unmarkPurchaseOrderComplete"],
    why: "Delete a purchase order, or reopen one marked complete.",
  },
  manageQuotes: {
    gate: [A.ACCOUNTS, A.FACILITIES_APPROVAL],
    routes: ["rejectQuote", "deleteQuote", "completeQuote", "uncompleteQuote", "validateQuote"],
    why: "Reject, delete, complete and validate quotes: a manager's or accounts' call, not a field officer's.",
  },
  manageServiceSchedules: {
    gate: MANAGE_SERVICE_SCHEDULES_ROLES,
    routes: ["upsertServiceSchedule", "archiveServiceSchedule", "importServiceSchedules"],
    why: "Add, edit, archive and import service schedules.",
  },
  manageTestData: {
    gate: [A.ADMIN],
    routes: ["setTestFlag"],
    why: "Show test data and mark or unmark a record as test data (D9, setTestFlag).",
  },
  markInvoiceInMyob: {
    gate: [A.ACCOUNTS_APPROVAL],
    refused: [A.ADMIN],
    routes: ["markJobInvoiceMyobCreated", "unmarkJobInvoiceMyobCreated"],
    why: `Record an invoice as keyed into MYOB by hand, or take that back; ${ADMIN_TEST_ONLY}.`,
  },
  markPurchaseOrderInMyob: {
    gate: [A.ACCOUNTS_APPROVAL, A.FACILITIES_APPROVAL],
    refused: [A.ADMIN],
    routes: ["markPurchaseOrderMyobCreated", "unmarkPurchaseOrderMyobCreated"],
    why: `Record a purchase order as keyed into MYOB by hand, or take that back; ${ADMIN_TEST_ONLY}.`,
  },
  mergeInspections: {
    gate: [A.ADMIN, A.DIRECTOR, A.FACILITIES, A.FACILITIES_APPROVAL],
    routes: ["mergeInspections"],
    why: "Combine draft inspections of one building (EDIT_INSPECTIONS_ROLES).",
  },
  myobController: {
    gate: [A.CFO],
    refused: [A.ADMIN, A.DIRECTOR],
    routes: ["setMyobControl", "pauseMyob", "acceptMyobBaseline", "runMyobLabProbe", "recordMyobLabResult"],
    why: "The CFO's MYOB switches and the pause, accepting MYOB's record as the baseline (SPR-M4), and the MYOB lab's probes and results (plan M5) (isMyobController: the cfo role, literally).",
  },
  overrideRentReviewChecks: {
    gate: [A.DIRECTOR],
    match: "exact",
    routes: [],
    why: "Override a rent review's rule checks with a reason: directors only.",
  },
  promoteEmail: {
    gate: [A.ACCOUNTS_APPROVAL, A.FACILITIES],
    routes: ["promoteEmailToJob", "promoteEmailToQuote", "promoteEmailToInvoice"],
    why: "Turn an email into a job, a quote or an invoice. Field officers do this (decision 1).",
  },
  raiseEscalation: {
    gate: [A.ADMIN, A.DIRECTOR, A.CFO, A.ACCOUNTS_APPROVAL, A.ACCOUNTS, A.FACILITIES_APPROVAL, A.FACILITIES],
    routes: ["raiseEscalation", "previewEscalationTarget"],
    why: "Escalate something to the right superior (ESCALATION_ROLES).",
  },
  ratifyScheduleChange: {
    gate: [A.DIRECTOR],
    refused: [A.ADMIN],
    routes: ["ratifyScheduleChange"],
    why: "Ratify a pending schedule change, which confers it on the tenancy's schedule (WP26c, D24; CHANGE_DECIDE_ROLES). The handler asks isDirector: admin is never a decider (D20), 403 and ledgered as denied.",
  },
  recordEmailOnJob: {
    gate: [A.ACCOUNTS_APPROVAL, A.FACILITIES_APPROVAL],
    routes: ["promoteEmailToJobUpdate", "recordEmailQuoteDecision"],
    why: "File an email reply on a job, or record a director's emailed decision (PROMOTE_EMAIL_ROLES, emails.ts).",
  },
  recordPayment: {
    gate: [A.ACCOUNTS_APPROVAL],
    refused: [A.ADMIN],
    routes: ["upsertPayment", "markPaymentPaid"],
    why: `Record a payment and mark it paid; ${ADMIN_TEST_ONLY}.`,
  },
  rejectInvoice: {
    gate: [A.ACCOUNTS_APPROVAL],
    routes: ["rejectJobInvoice"],
    why: "Reject an invoice.",
  },
  rejectScheduleChange: {
    gate: [A.DIRECTOR],
    refused: [A.ADMIN],
    routes: ["rejectScheduleChange"],
    why: "Reject a pending schedule change, with a note (CHANGE_DECIDE_ROLES). As ratifying: admin is never a decider (D20).",
  },
  reopenJob: {
    gate: [A.FACILITIES_APPROVAL, A.ACCOUNTS_APPROVAL, A.CFO, A.DIRECTOR],
    refused: [A.ADMIN],
    routes: ["reopenJob"],
    why: "Reopen a done job with a reason (REOPEN_ROLES, J2): not admin, since reopening touches money records.",
  },
  requestScheduleChange: {
    gate: TENANCY_DESK,
    routes: ["requestScheduleChange", "withdrawScheduleChange"],
    why: "Ask for a change to a tenancy's schedule, such as rent relief for a period, and withdraw it (CHANGE_REQUEST_ROLES, the tenancy edit roles). Withdrawing is the requester's alone on top of this list: anyone else gets 403, ledgered as denied.",
  },
  resendDirectorEmail: {
    gate: [A.ACCOUNTS, A.DIRECTOR, A.FACILITIES],
    routes: ["resendDirectorQuoteEmail", "resendDirectorInvoiceEmail"],
    why: "Send the director's approval request again.",
  },
  respondToDecision: {
    gate: RESPOND_TO_DECISION_ROLES,
    routes: ["respondToJobDecision"],
    why: "Answer a decision you were asked for (the request names who).",
  },
  revertAnyInspection: {
    gate: [A.ADMIN, A.DIRECTOR, A.FACILITIES, A.FACILITIES_APPROVAL],
    refused: [A.FACILITIES],
    routes: ["revertInspection"],
    why: "Reopen any completed inspection. Plain facilities reopen only their own.",
  },
  revertRentReview: {
    gate: REVIEW_APPROVERS,
    refused: [A.ADMIN],
    routes: ["revertRentReview"],
    why: "Revert an applied rent review (REVIEW_APPROVE_ROLES). Admin is refused.",
  },
  sendPurchaseOrder: {
    gate: [A.ACCOUNTS_APPROVAL, A.FACILITIES_APPROVAL],
    routes: ["sendPurchaseOrder", "previewPurchaseOrder"],
    why: "Preview and send a purchase order to its contractor.",
  },
  setJobPathFlags: {
    gate: roles(FLAG_ROLES),
    match: "exact",
    routes: [],
    why: "Mark a job standing-contract or internal (FLAG_ROLES, J2), before it has money records.",
  },
  signOffTenancySchedule: {
    gate: [A.ACCOUNTS_APPROVAL, A.CFO, A.DIRECTOR],
    refused: [A.ADMIN],
    routes: ["signOffTenancySchedule", "revokeTenancyScheduleSignOff"],
    why: "Sign a tenancy's schedule off against the lease, or take it back (SIGN_OFF_ROLES, checked literally after the gate).",
  },
  submitRentReview: {
    gate: TENANCY_DESK,
    routes: ["submitRentReview"],
    why: "Submit a calculated rent review (REVIEW_APPLY_ROLES, rentReview/http.ts).",
  },
  syncBuildings: {
    gate: [A.ADMIN],
    routes: ["syncBuildings"],
    why: "Pull buildings from myBuildings.",
  },
  syncWorkRequests: {
    gate: [A.ADMIN],
    routes: ["syncAllWorkRequests"],
    why: "Pull every work request from myBuildings.",
  },
  unapproveQuote: {
    gate: [A.ACCOUNTS_APPROVAL],
    routes: ["unapproveQuote"],
    why: "Undo a quote approval (Deselect).",
  },
  unflagEmail: {
    gate: [A.FACILITIES_APPROVAL],
    routes: ["unflagEmail"],
    why: "Put an email the AI couldn't read back into Incoming.",
  },
  viewAccessLog: {
    gate: [A.CFO],
    routes: ["getAccessEvents"],
    why: "Recent sign-ins and anomalies (ACCESS_VIEW_ROLES).",
  },
  viewAdmin: {
    gate: [A.ADMIN],
    routes: ["upsertFeatureFlag"],
    why: "The Admin pages.",
  },
  viewAllEscalations: {
    gate: [A.DIRECTOR],
    routes: [],
    why: "Every escalation in the business (ALL_ESCALATION_ROLES, getEscalations?view=all).",
  },
  viewAssets: {
    gate: VIEW_ASSETS_ROLES,
    routes: ["getAssets", "getAsset", "getLocations", "getAssetTypes"],
    why: "Read the asset register.",
  },
  viewDecisions: {
    gate: [A.DIRECTOR, A.CFO],
    routes: ["getDecisions"],
    why: "Decisions & exceptions.",
  },
  viewEscalations: {
    gate: [A.ADMIN, A.DIRECTOR, A.CFO, A.ACCOUNTS_APPROVAL, A.ACCOUNTS, A.FACILITIES_APPROVAL, A.FACILITIES],
    routes: ["getEscalation", "acknowledgeEscalation", "resolveEscalation", "withdrawEscalation", "escalateFurther"],
    why: "The escalation inbox (ESCALATION_ROLES).",
  },
  viewInspections: {
    gate: [A.FACILITIES, A.FACILITIES_APPROVAL],
    routes: ["getInspections", "getInspection"],
    why: "Read inspections.",
  },
  viewInvoices: {
    gate: [A.ACCOUNTS, A.DIRECTOR, A.FACILITIES],
    routes: ["getJobInvoices", "getInvoices"],
    why: "Read a job's invoices.",
  },
  viewJobDecisionHistory: {
    gate: JOB_READ,
    routes: [],
    why: "A job's Decision history: whoever may read the job (historyRoles.ts JOB_READ).",
  },
  viewJobs: {
    gate: JOB_READ,
    routes: ["getJobs", "getJob"],
    why: "Read jobs, their history and their packet.",
  },
  viewKeys: {
    gate: [A.FACILITIES, A.FACILITIES_APPROVAL],
    routes: ["getKeys", "getKeyDetail"],
    why: "Read the key register.",
  },
  viewMaintenanceOverview: {
    gate: VIEW_FACILITIES_ROLES,
    routes: ["getMaintenanceOverview", "getDefectsPeriods", "getServiceSchedules"],
    why: "Defects periods, service schedules and the maintenance overview.",
  },
  viewMyobControls: {
    gate: [A.CFO],
    routes: ["getMyobControls", "getMyobActivity", "reconcileMyob", "getMyobLab"],
    why: "Read the MYOB controls, the Activity view and reconciliation (SPR-M4), and the MYOB lab (plan M5).",
  },
  viewPayments: {
    gate: [A.ACCOUNTS, A.ACCOUNTS_APPROVAL, A.DIRECTOR],
    routes: ["getPayments"],
    why: "Read a job's payments.",
  },
  viewPayroll: {
    gate: [A.ADMIN, A.DIRECTOR, A.FACILITIES_APPROVAL, A.ACCOUNTS_APPROVAL],
    match: "exact",
    routes: ["getTimesheets"],
    why: "The Payroll page (isApprovalManager, timesheets.ts: a literal role check).",
  },
  viewPortfolioOccupancy: {
    gate: [A.ACCOUNTS, A.ACCOUNTS_APPROVAL, A.ADMIN, A.DIRECTOR, A.FACILITIES, A.FACILITIES_APPROVAL],
    routes: ["getPortfolioOccupancy"],
    why: "Per-building occupancy.",
  },
  viewPurchaseOrders: {
    gate: [A.ACCOUNTS, A.DIRECTOR, A.FACILITIES],
    routes: ["getPurchaseOrders"],
    why: "Read a job's purchase orders.",
  },
  viewQuotes: {
    gate: [A.ACCOUNTS, A.ACCOUNTS_APPROVAL, A.FACILITIES, A.FACILITIES_APPROVAL, A.DIRECTOR],
    routes: ["getQuotes"],
    why: "Read a job's quotes.",
  },
  viewRentReviews: {
    gate: TENANCY_DESK,
    routes: ["getRentReviews", "getRentReview", "getUpcomingLeaseEvents"],
    why: "Rent reviews and the lease-events feed (TENANCY_VIEW_ROLES).",
  },
  viewTeamEscalations: {
    gate: [A.FACILITIES_APPROVAL, A.ACCOUNTS_APPROVAL, A.CFO],
    routes: [],
    why: "The escalation inbox's Team view (TEAM_ESCALATION_ROLES, getEscalations?view=team).",
  },
  viewTenancy: {
    gate: TENANCY_DESK,
    routes: ["getRegisterTenants", "getRegisterTenant", "getScheduleChanges"],
    why: "The tenancy register, a tenant's detail and its schedule changes (TENANCY_VIEW_ROLES, CHANGE_VIEW_ROLES).",
  },
  viewTenancyDecisionHistory: {
    gate: TENANCY_DESK,
    routes: [],
    why: "A tenancy's Decision history (historyRoles.ts TENANCY_READ).",
  },
  viewTimesheets: {
    gate: [A.USER],
    routes: ["getTimesheet"],
    why: "Your own timesheet: any assigned role.",
  },
  viewUserManagement: {
    gate: [A.ADMIN, A.DIRECTOR],
    routes: ["upsertAppUser"],
    why: "User management (MANAGE_USER_ROLES, users.ts).",
  },
  viewVacancies: {
    gate: [A.ADMIN, A.DIRECTOR, A.FACILITIES, A.FACILITIES_APPROVAL, A.ACCOUNTS, A.ACCOUNTS_APPROVAL],
    routes: ["getVacancies", "getVacancy"],
    why: "Read vacancies (VACANCY_ROLES, vacancies.ts).",
  },
  verifyAssets: {
    gate: VERIFY_ASSETS_ROLES,
    routes: ["verifyAsset"],
    why: "Stamp an asset as verified.",
  },
  waiveMarketRentReview: {
    gate: [A.DIRECTOR],
    match: "exact",
    routes: [],
    why: "Waive a market rent review: a director's alone.",
  },
  waiveRentReview: {
    gate: REVIEW_APPROVERS,
    refused: [A.ADMIN],
    routes: ["waiveRentReview"],
    why: "Waive a rent review with a reason (REVIEW_APPROVE_ROLES). Admin is refused.",
  },
} as const satisfies Record<string, ActionRoles>;

export type Capability = keyof typeof ACTION_ROLES;

/** Every role, in a fixed order, for the export and the parity sweep. */
export const ALL_ROLES: readonly AppRole[] = Object.values(AppRole).slice().sort();

/** The roles an entry lets act: who passes its gate (by requireRole's hierarchy, or literally), less those refused or conditional. */
export function rolesFor(entry: ActionRoles): AppRole[] {
  const left = [...(entry.refused ?? []), ...(entry.conditional ?? [])];
  return admittedBy(entry).filter((role) => !left.includes(role));
}

/** Everyone an entry's gate lets past, refused and conditional roles included. */
export function admittedBy(entry: ActionRoles): AppRole[] {
  return entry.match === "exact"
    ? ALL_ROLES.filter((role) => entry.gate.includes(role))
    : ALL_ROLES.filter((role) => rolesPassGate([role], entry.gate));
}

/** The table as the frontend reads it: capability → the roles that may, sorted. */
export function exportActionRoles(): Record<Capability, AppRole[]> {
  const out = {} as Record<Capability, AppRole[]>;
  for (const key of Object.keys(ACTION_ROLES).sort() as Capability[]) {
    out[key] = rolesFor(ACTION_ROLES[key]);
  }
  return out;
}
