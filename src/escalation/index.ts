// The escalation engine's public surface for the packages that build on it
// (WP21's quote, invoice and PO adapters, WP26 rent reviews, WP61 correspondence
// ...): raise and move escalations, register an adapter for a subject type, and
// pick a policy. Import from here; the other files in this folder are internal.
//
//   registerAdapter({ subjectType: "quote", deepLink, isConditionActive, loadSummary, visibleTo, ... })
//   await raise(connection, { actor, policyKey: "quote.over_limit", subjectType: "quote", subjectId, ... })
//
// An authority escalation ends with the domain's decision, which is WP21's
// to wire up (it will resolve the escalation in the decision's own transaction).
// The engine never decides for the domain, and its resolve refuses authority
// escalations from the inbox. A domain that writes its own rows beside the
// escalation raises it with raiseWithin and ends it with withdrawWithin or
// resolveWithin, on a transaction it owns (the decision requests and next steps of
// jobs plan A1 and A2 do).

export {
  acknowledge,
  autoResolve,
  escalateFurther,
  hasNextLevel,
  previewTarget,
  raise,
  raiseWithin,
  resolve,
  resolveWithin,
  SWEEP_ACTOR,
  withdraw,
  withdrawWithin,
} from "./engine";
export type {
  AcknowledgeInput,
  AutoResolveInput,
  EscalateFurtherInput,
  EscalateFurtherResult,
  RaiseInput,
  RaiseResult,
  RaiseWithinResult,
  ResolveInput,
  ResolveWithinInput,
  WithdrawInput,
} from "./engine";
export { registerAdapter } from "./adapters";
export type { ConditionRef, EscalationAdapter, SubjectSummary } from "./adapters";
export { EscalationError } from "./errors";
export type { AuthorityRouteStep } from "./ladder";
export { invalidatePolicyCache } from "./policies";
export type { EscalationPolicy, EscalationRow, LadderEntry } from "./types";
