// The AI gateway's public face (SC-AI1). Other code calls runAi and nothing else:
// providers, redaction and the log are internal, and a test keeps them that way.

export { resolveAiActor } from "./actor";
export { isConfigured, readAiConfig } from "./config";
export { throttledResponse } from "./http";
export { AiAuditError } from "./refusals";
export { listPurposeIds } from "./registry";
export { runAi } from "./runAi";
export type {
  AiActor,
  AiCallMeta,
  AiOutcome,
  AiPurpose,
  AiRefusal,
  AiRefusalCode,
  AiRequest,
  AiResult,
  AiValidation,
} from "./types";
export { AI_OUTCOMES, AI_REFUSAL_CODES, definePurpose } from "./types";
