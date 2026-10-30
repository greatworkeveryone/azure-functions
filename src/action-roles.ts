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

import { EVENT_READ_ROLES, OPERATIONAL_EVENT_MANAGERS, FINANCIAL_EVENT_MANAGERS } from "./majorEvents";
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
import { MANAGE_COVER_ROLES, VIEW_COVER_ROLES } from "./absenceCover/roles";

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
  viewDocumentation: { gate: [A.USER], routes: ["getDocumentRegister", "downloadRegisterDocument", "askLibrary"], why: "Unified metadata discovery; each source retains its own role/audience and test-data filters. User-only readers see procedures only. Ask the Library (askLibrary) answers from passages the browser chose out of the procedures this person can already read; the gateway adds its own switch and rate limit." },
  editRegisterDocuments: { gate: VIEW_ASSETS_ROLES, routes: ["uploadRegisterDocument", "updateRegisterDocument"], why: "Record original operational documents. Metadata updates require ownership or management; tenancy scope additionally requires tenancy access." },
  viewMajorEvents: { gate: EVENT_READ_ROLES, match: "exact", routes: ["getMajorEvents", "getMajorEvent", "addMajorEventEntry", "uploadMajorEventDocument", "getMajorEventDocument", "exportMajorEventPack"], why: "Operational event coordination for operational staff; each event further restricts reads and contributions to its selected audience, always including its management authority." },
  manageOperationalEvents: { gate: [A.ADMIN, ...OPERATIONAL_EVENT_MANAGERS], match: "exact", routes: [], why: "Admin, facilities managers and directors create/edit operational event plans; only facilities managers/directors close them." },
  manageFinancialEvents: { gate: [A.ADMIN, ...FINANCIAL_EVENT_MANAGERS], match: "exact", routes: [], why: "Admin and CFO/directors create/edit financial event plans; only CFO/directors close them. No money approval authority is granted." },
  manageMajorEvents: { gate: [A.ADMIN, A.FACILITIES_APPROVAL, A.CFO, A.DIRECTOR], match: "exact", routes: ["createMajorEvent", "updateMajorEvent", "closeMajorEvent"], why: "Outer gate for planning/closure. Admin may create/edit plans; closure retains domain-specific Facilities Manager or CFO/director authority." },
  addQuoteContractor: {
    gate: [A.ACCOUNTS, A.FACILITIES],
    routes: ["addJobRequestedContractor", "removeJobRequestedContractor", "toggleRequestedContractorSent", "suggestContractors", "recordContractorSuggestionOutcome"],
    why: "Request quotes: keep a job's list of contractors asked to quote, and see who is suggested for it. Field officers do this (decision 1). Everyone who may raise a purchase order is in this list, so suggestions serve both choosing a contractor to ask and one to assign.",
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
  manageProcedureEndorsement: {
    gate: [A.CFO, A.DIRECTOR], match: "exact",
    routes: ["setProcedureEndorsement"],
    why: "Classify each procedure for team-manager or CFO/director endorsement, with an audit trail.",
  },
  approveProcedures: {
    gate: [A.DIRECTOR, A.CFO, A.FACILITIES_APPROVAL, A.ACCOUNTS_APPROVAL],
    refused: [A.ADMIN],
    routes: ["publishProcedure"],
    why: "Publish a procedure, which stamps the approval onto that version. The handler checks each procedure’s team/executive endorsement policy; admin alone is refused.",
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
  approveOptionExercise: {
    gate: REVIEW_APPROVERS,
    refused: [A.ADMIN],
    routes: ["approveOptionExercise"],
    why: `Approve a recorded option notice, which extends the lease and its schedule (OPTION_APPROVE_ROLES, leaseEvents/http.ts); not the notice's recorder; ${ADMIN_TEST_ONLY}.`,
  },
  approveRentReview: {
    gate: REVIEW_APPROVERS,
    refused: [A.ADMIN],
    routes: ["approveRentReview", "returnRentReview"],
    why: "Approve a rent review, or return it to its preparer (REVIEW_APPROVE_ROLES). Admin is never an approver (D20).",
  },
  approveTimesheets: {
    gate: [A.ADMIN, A.DIRECTOR, A.CFO, A.FACILITIES_APPROVAL, A.ACCOUNTS_APPROVAL],
    match: "exact",
    routes: ["approveTimesheet"],
    why: "Approve timesheets (isApprovalManager, timesheets.ts: a literal role check).",
  },
  archiveAnyJob: {
    gate: [A.ADMIN, A.DIRECTOR, A.CFO, A.FACILITIES_APPROVAL, A.ACCOUNTS_APPROVAL],
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
  archiveTenancyParts: {
    gate: TENANCY_DESK,
    routes: ["archiveOccupancy", "unarchiveOccupancy", "archiveCarpark", "unarchiveCarpark"],
    why: "Archive or restore an area or a car park bay, with a reason (D10, replacing the hard deletes). Archive is reversible and ledgered, and the Edit tenancy modal archives the areas it removes, so it is the tenancy desk's.",
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
    routes: ["upsertQuote", "extractDocumentFields"],
    why: "Add or edit a received quote. Field officers do this (decision 1); approving one is approveQuote. extractDocumentFields (Read this document, SC-AI2) shares this gate for quotes and invoices alike, because createInvoice is the same list.",
  },
  createTestData: {
    gate: [A.ADMIN, A.DIRECTOR],
    match: "exact",
    routes: [],
    why: "Create a record marked as test data (D9). It gates the create forms' test checkbox; the rule itself lives inside the creates (test-data.ts testFlagForCreate, a literal admin-or-director check), so no route of its own.",
  },
  createWorkRequest: {
    gate: [A.FACILITIES_APPROVAL],
    routes: ["createWorkRequest"],
    why: "File a new work request from Job Intake, which creates it in myBuildings first: facilities managers, with admin and directors through the hierarchy. Field officers and accounts are refused, so the New request button is not offered to them.",
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
    routes: ["createInspection", "applyInspectionOps", "completeInspection", "uploadInspectionAttachment", "raiseJobsFromInspection", "tidyInspectionJobTitles"],
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
    routes: ["saveProcedureDraft", "requestProcedureApproval"],
    why: "Write procedure drafts and ask a director to approve one (PROCEDURE_EDITOR_GATE, procedureRoles.ts).",
  },
  editTenancy: {
    gate: TENANCY_DESK,
    routes: [
      "upsertRegisterTenant",
      "upsertOccupancy",
      "upsertCarpark",
      "upsertMiscFee",
      "upsertTenantIncentive",
      "upsertLeaseAdministration",
      "archiveTenantNote",
      "unarchiveTenantNote",
    ],
    why: "Edit the tenancy register and a tenant's detail, and archive or restore its notes with a reason (D11).",
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
  manageManualBuildings: {
    gate: [A.ADMIN],
    routes: ["upsertManualBuilding"],
    why: "Add a building myBuildings doesn't manage, and edit it (upsertManualBuilding: authorizeWrite with ADMIN only).",
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
    routes: ["saveMaintenanceCoverage", "saveContractorCoverage", "upsertServiceSchedule", "archiveServiceSchedule", "importServiceSchedules"],
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
  overrideLeaseEventChecks: {
    gate: [A.DIRECTOR],
    match: "exact",
    routes: [],
    why: "Accept an option notice dated outside its window, approve an exercise with the schedule not signed off, or approve a notice you recorded, each with a reason: directors only (D23).",
  },
  overrideRentReviewChecks: {
    gate: [A.DIRECTOR],
    match: "exact",
    routes: [],
    why: "Override a rent review's rule checks with a reason: directors only.",
  },
  promoteEmail: {
    gate: [A.ACCOUNTS, A.ACCOUNTS_APPROVAL, A.FACILITIES],
    routes: ["promoteEmailToJob", "promoteEmailToQuote", "promoteEmailToInvoice"],
    why: "Turn an email into a job, a quote or an invoice. Field officers do this (decision 1).",
  },
  viewEmailRouting: {
    gate: [A.FACILITIES, A.FACILITIES_APPROVAL, A.ACCOUNTS, A.ACCOUNTS_APPROVAL],
    routes: ["getEmailRouting"],
    why: "See, on each Incoming email, which mailbox it came from, who has it and why, and the send it replies to. Same people as read Incoming itself (getEmails).",
  },
  // Tenant requests (TR1, PLAN §15). Reading the intake state is reading work requests. Acknowledging sends mail
  // from notices@ (admin is refused, as for sendEmail); moving a request on and setting the promise do not.
  viewRequestIntake: {
    gate: [A.FACILITIES, A.ACCOUNTS],
    routes: ["getRequestIntake", "getIntakeTargets"],
    why: "See, on each incoming request, where it is in intake (received, acknowledged, assessing, job raised, closed), who acknowledged it and when, and the response target if Facilities has set one. Same people as read work requests.",
  },
  acknowledgeRequest: {
    gate: [A.FACILITIES, A.ACCOUNTS],
    refused: [A.ADMIN],
    routes: ["acknowledgeWorkRequest"],
    why: "Acknowledge an incoming tenant request: one click sends the approved request_ack email from notices@ to the person who reported it, and records who and when. Property and facilities staff and above. Admin is refused: it sends nothing real.",
  },
  moveRequestIntake: {
    gate: [A.FACILITIES, A.ACCOUNTS],
    routes: ["moveWorkRequestIntake"],
    why: "Move an acknowledged request to Assessing, or close any open one as a duplicate or not ours (with the reason). Nothing is sent. Same people as read work requests.",
  },
  setIntakeTargets: {
    gate: [A.FACILITIES_APPROVAL],
    routes: ["setIntakeTargets"],
    why: "Set, per priority, how many business hours Facilities promises to acknowledge a request within. Unset means no clock and no escalation. The facilities manager's call; directors, the CFO and admin through the hierarchy.",
  },
  triageIncomingEmail: {
    gate: [A.FACILITIES_APPROVAL, A.ACCOUNTS_APPROVAL],
    routes: ["getTriageQueue", "assignEmail"],
    why: "Work the Needs triage queue and give an Incoming email to someone, or move it to someone else (EB3). The team managers' job; directors, the CFO and admin through the hierarchy. Field officers see who has an email, they do not hand it out.",
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
  recordOptionNotice: {
    gate: TENANCY_DESK,
    routes: ["recordOptionNotice"],
    why: "Record a tenant's notice exercising a lease option (OPTION_RECORD_ROLES, leaseEvents/http.ts: the editTenancy roles).",
  },
  recordRenewalOutcome: {
    gate: [A.DIRECTOR],
    refused: [A.ADMIN],
    routes: ["recordRenewalOutcome"],
    why: `Decide a lease referred for renewal: renewed, vacating or holdover (LEASE_DIRECTOR_ROLES); ${ADMIN_TEST_ONLY}.`,
  },
  rejectOptionNotice: {
    gate: [A.DIRECTOR],
    refused: [A.ADMIN],
    routes: ["rejectOptionNotice", "correctOptionsRemaining"],
    why: `Reject a recorded option notice, or correct a lease's options left, each with a reason (LEASE_DIRECTOR_ROLES); ${ADMIN_TEST_ONLY}.`,
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
  runAiHealthCheck: {
    gate: [A.ADMIN],
    routes: ["runAiHealthCheck"],
    why: "Send a test call through the AI gateway (echo_test) to check the switch, the provider and the log: admin only, as the other technical administration (viewTechnicalSettings). It reads no record and takes no input.",
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
  viewAiActivity: {
    gate: [A.ADMIN, A.DIRECTOR],
    routes: ["listAiCalls"],
    why: "Admin → AI activity: the log of every AI call (who, which purpose, how big, how it ended): admin and directors, as Settings and rollout controls (viewAdmin). No route returns stored text.",
  },
  viewFloorplanPerformance: {
    gate: [A.ADMIN, A.DIRECTOR], match: "exact",
    routes: ["getFloorplanPerformance", "getFloorplanAdoption", "getPerformanceImprovements", "getWorkflowFriction"],
    why: "Whole-business workflow performance, recorded bottlenecks and improvement history; the CFO retains finance-only usage.",
  },
  manageFloorplanImprovements: {
    gate: [A.DIRECTOR], match: "exact",
    routes: ["savePerformanceImprovement"],
    why: "Directors set and review operating targets, with revision checks and immutable history; this grants no financial authority.",
  },
  recordWorkflowSignals: {
    gate: [A.USER],
    routes: ["postWorkflowSignals"],
    why: "Opt-in bounded request-outcome telemetry for the verified caller; no input content or record identifiers.",
  },
  viewUsageAnalytics: {
    gate: [A.ADMIN, A.DIRECTOR],
    routes: ["getUsageOverview", "getUsagePeople", "getUsageDevices", "getUsageModules", "getUsageEmail", "getUsageAi"],
    why: "Audit log → Usage: who uses Floorplan, for how long, on what kind of device, plus the email and AI breakdowns (PLAN §14): admin and directors. The CFO is refused these routes and has the Finance view instead (usage/scope.ts holds the scope).",
  },
  viewFinanceUsageAnalytics: {
    gate: [A.CFO],
    routes: ["getUsageFinance"],
    why: "Audit log → Usage → Finance usage: accounts, accounts manager, CFO and admin people, MYOB calls and money decisions only (PLAN §14): the CFO, with admin and directors through the hierarchy. The server holds the CFO to that scope whatever filters are sent.",
  },
  manageUsageAnalytics: {
    gate: [A.ADMIN],
    routes: ["labelUsageDevice", "runUsageRollup"],
    why: "Name a shared device (\"Facilities tablet\") and run the usage roll-up now (PLAN §14): admin only.",
  },
  viewFinanceControlsPack: { gate: [A.CFO, A.DIRECTOR], routes: ["getFinanceControlsPack"], why: "Read the CFO controls matrix and sign-off history (WP55)." },
  signFinanceControlsPack: { gate: [A.CFO], match: "exact", routes: ["signFinanceControlsPack"], why: "The CFO records her review of the current controls pack; this enables no MYOB writes." },
  manageApprovalLimits: {
    gate: [A.CFO, A.DIRECTOR], match: "exact", routes: ["setApprovalLimit"],
    why: "The CFO or a director sets approval limits; confirmed, money-gated and ledgered (WP55).",
  },
  manageVarianceMargin: {
    gate: [A.CFO, A.DIRECTOR, A.ADMIN],
    match: "exact",
    conditional: [A.DIRECTOR, A.ADMIN],
    routes: ["setApprovalFact"],
    why: "The CFO sets variance margin and cap; only a director or admin sets the director approval threshold; every change is money-gated and ledgered (decision 17).",
  },
  // Native email (EB1, PLAN §13). The server composes every signature and checks every reply-to; these gates
  // only say who may use the comms routes. Admin passes the gates but is turned away by the handlers of the
  // two that send or approve real mail (the same rule as the approvals above: admin acts on test records only).
  sendEmail: {
    gate: [A.FACILITIES, A.ACCOUNTS],
    refused: [A.ADMIN],
    routes: ["listCommsIdentities", "previewCorrespondence", "queueCorrespondence", "cancelCorrespondence", "sendTestCorrespondence"],
    why: "Send email from Floorplan: choose a reply-to identity and a signature, preview, queue and cancel a send. Property and facilities staff and above. Admin is refused: it sends nothing real.",
  },
  approveEmail: {
    gate: [A.ACCOUNTS_APPROVAL, A.CFO, A.DIRECTOR, A.FACILITIES_APPROVAL],
    refused: [A.ADMIN],
    routes: ["approveCorrespondence"],
    why: "Approve a large send (over COMMS_APPROVAL_THRESHOLD recipients): a manager, the CFO or a director, never the person who queued it. The handler checks that; admin approves nothing real and is refused.",
  },
  viewCorrespondence: {
    gate: [A.FACILITIES, A.ACCOUNTS],
    routes: ["getCorrespondence", "listCorrespondence"],
    why: "Read a send job and its recipients, and list sends. The handlers further limit it to whoever queued the job and the managers who approve sends.",
  },
  sendBroadcast: {
    gate: [A.FACILITIES_APPROVAL, A.ACCOUNTS_APPROVAL, A.DIRECTOR],
    routes: ["resolveBroadcastAudience", "getBroadcastOptions"],
    why: "Build and send an email broadcast (Tools, Email broadcast): choose an audience, see who would get it, write it, preview it. Managers and directors (the CFO through the accounts manager rule). Admin passes the gate so the screens can be tried, but queueing and the test send refuse admin (sendEmail), so nothing real goes from an admin account.",
  },
  manageEmailIdentities: {
    gate: [A.ADMIN],
    routes: ["manageCommsIdentities"],
    why: "Admin → Email identities: the reply-to addresses, the roles allowed to send on their behalf and their team signatures. Admin only.",
  },
  editMySignature: {
    gate: [A.USER],
    routes: ["getMySignature", "updateMySignature"],
    why: "Your own standard signature: your job title and phone. Any assigned role edits their own; an admin may edit another person's (the handler checks).",
  },
  viewTechnicalSettings: { gate: [A.ADMIN], match: "exact", routes: [], why: "Technical administration pages remain admin-only; directors have business Settings." },
  viewAdmin: {
    gate: [A.ADMIN, A.DIRECTOR],
    routes: ["upsertFeatureFlag"],
    why: "Settings and rollout controls: admin and directors (decision 6); CFO controls live in Finance.",
  },
  viewAllEscalations: {
    gate: [A.DIRECTOR],
    routes: [],
    why: "Every escalation in the business (ALL_ESCALATION_ROLES, getEscalations?view=all).",
  },
  viewLeave: {
    gate: [A.USER],
    routes: ["getLeaveRequests", "createLeaveRequest", "decideLeaveRequest", "getCoverDelegates", "saveCoverDelegate", "archiveCoverDelegate", "getMyHandback", "takeBackCoverItem"],
    why: "Own leave and server-filtered review queue; per-record authority is enforced. Also who covers for you while you are away (AW1): you, your manager or your team's manager nominate, and you take back what moved while you were away.",
  },
  viewAbsenceCover: {
    gate: roles(VIEW_COVER_ROLES),
    routes: ["getCoverOverview"],
    why: "The Covering screen: who is away, what is waiting on them and what moved (AW1, VIEW_COVER_ROLES). A manager sees their own team; the CFO and directors see more.",
  },
  manageAbsenceCover: {
    gate: roles(MANAGE_COVER_ROLES),
    refused: [A.ADMIN],
    routes: ["decideCoverItem"],
    why: "Move an item to its cover, or keep it where it is (AW1). The gate admits admin through the hierarchy and the handler refuses it: admin arranges nobody's work (decision 4). Live only: nothing moves while ABSENCE_COVER_ENABLED is unset or in dry run.",
  },
  manageStaffReporting: { gate: [A.CFO,A.DIRECTOR], routes: ["getStaffReporting", "saveStaffReporting"], why: "CFO reporting controls for leave routing; no money or timesheet authority changes." },
  viewBuildingRegister: {
    gate: VIEW_ASSETS_ROLES,
    routes: ["getBuildingRegister"],
    why: "Read building, lot and contact details; existing operational-reader roles.",
  },
  editBuildingRegister: {
    gate: MANAGE_ASSET_TYPES_ROLES,
    routes: ["saveBuildingRegister"],
    why: "Maintain building/lot facts and contacts; existing property-manager roles (admin, director and facilities manager).",
  },
  viewAssets: {
    gate: VIEW_ASSETS_ROLES,
    routes: ["getAssets", "getAsset", "getLocations", "getAssetTypes"],
    why: "Read the asset register.",
  },
  viewAuditLog: { gate: [A.FACILITIES_APPROVAL,A.CFO,A.DIRECTOR], routes: ["getAuditLog"], why: "Cross-application audit: Facilities managers receive operational metadata only; CFO/director/admin receive all recorded areas." },
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
    routes: ["getJobs", "getJob", "getCoverNotes"],
    why: "Read jobs, their history and their packet, and who is covering a job while its owner is away.",
  },
  viewKeys: {
    gate: [A.FACILITIES, A.FACILITIES_APPROVAL],
    routes: ["getKeys", "getKeyDetail"],
    why: "Read the key register.",
  },
  viewMaintenanceOverview: {
    gate: VIEW_FACILITIES_ROLES,
    routes: ["getMaintenanceCoverage", "getMaintenanceOverview", "getDefectsPeriods", "getServiceSchedules", "getRecurringFaults"],
    why: "Defects periods, service schedules, the maintenance overview and recurring-fault signals.",
  },
  viewMyobControls: {
    gate: [A.CFO],
    routes: ["getMyobControls", "getMyobActivity", "reconcileMyob", "getMyobLab"],
    why: "Read the MYOB controls, the Activity view and reconciliation (SPR-M4), and the MYOB lab (plan M5).",
  },
  viewOperationsReports: {
    gate: [A.CFO, A.FACILITIES_APPROVAL],
    routes: ["getMaintenanceSpendReport", "getComplianceReport"],
    why: "The operations reports in Tools → Reports (maintenance spend, compliance): the CFO, directors and admin, and facilities managers. Reads only, commercial buildings only.",
  },
  viewPayments: {
    gate: [A.ACCOUNTS, A.ACCOUNTS_APPROVAL, A.DIRECTOR],
    routes: ["getPayments"],
    why: "Read a job's payments.",
  },
  viewPayroll: {
    gate: [A.ADMIN, A.DIRECTOR, A.CFO, A.FACILITIES_APPROVAL, A.ACCOUNTS_APPROVAL],
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
  viewLeaseEvents: {
    gate: TENANCY_DESK,
    routes: ["getTenancyLeaseEvents"],
    why: "A tenancy's option exercises and renewals (LEASE_EVENT_VIEW_ROLES: the roles that may read a tenancy).",
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
    routes: ["getRegisterTenants", "getRegisterTenant", "getScheduleChanges", "getReviewsDue"],
    why: "The tenancy register, a tenant's detail and its schedule changes (TENANCY_VIEW_ROLES, CHANGE_VIEW_ROLES).",
  },
  viewTenancyDecisionHistory: {
    gate: TENANCY_DESK,
    routes: [],
    why: "A tenancy's Decision history (historyRoles.ts TENANCY_READ).",
  },
  viewTenancySchedule: {
    gate: [A.DIRECTOR, A.CFO],
    routes: ["getTenancySchedule"],
    why: "The Tenancy Schedule report: every lease's rent, contacts and notes (TENANCY-SCHEDULE-REPORT decision 5).",
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
