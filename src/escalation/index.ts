// The escalation engine's public surface for the packages that build on it
// (WP21's quote, invoice and PO adapters, WP26 rent reviews, WP61 correspondence
// ...): raise and move escalations, register an adapter for a subject type, and
// pick a policy. Import from here; the other files in this folder are internal.
//
//   registerAdapter({ subjectType: "quote", deepLink, isConditionActive, loadSummary, visibleTo, ... })
//   await raise(connection, { actor, policyKey: "quote.over_limit", subjectType: "quote", subjectId, ... })
//
// An authority escalation ends with the domain's decision: once the decision
// has committed, the domain calls concludeForSubject (WP26's rent reviews do;
// WP21 wires quotes, invoices and POs the same way). The engine never decides
// for the domain, and its resolve refuses authority escalations from the inbox.
// A domain that writes its own rows beside the escalation raises it with
// raiseWithin and ends it with withdrawWithin, on a transaction it owns (the
// decision requests of jobs plan A1 do).

export {
  acknowledge,
  autoResolve,
  concludeForSubject,
  escalateFurther,
  hasNextLevel,
  previewTarget,
  raise,
  raiseWithin,
  resolve,
  SWEEP_ACTOR,
  withdraw,
  withdrawWithin,
} from "./engine";
export type {
  AcknowledgeInput,
  AutoResolveInput,
  ConcludeInput,
  EscalateFurtherInput,
  EscalateFurtherResult,
  RaiseInput,
  RaiseResult,
  RaiseWithinResult,
  ResolveInput,
  WithdrawInput,
} from "./engine";
export { registerAdapter } from "./adapters";
export type { ConditionRef, EscalationAdapter, SubjectSummary } from "./adapters";
export { EscalationError } from "./errors";
export type { AuthorityRouteStep } from "./ladder";
export { invalidatePolicyCache } from "./policies";
export type { EscalationPolicy, EscalationRow, LadderEntry } from "./types";
