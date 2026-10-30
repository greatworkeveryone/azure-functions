// certificate_extraction: reads the text of a contractor's certificate of currency and returns the
// fields the certificate form asks for (TR8). The answer only ever prefills a form that a person
// then checks; nothing is saved by it.

import { CERTIFICATE_MAX_INPUT_CHARS, CERTIFICATE_MAX_OUTPUT_TOKENS, CERTIFICATE_PROMPT, mockCertificateFields, validateCertificateFields, type CertificateFieldValues } from "../certificateFields";
import { definePurpose } from "../types";

export const purpose = definePurpose<CertificateFieldValues>({
  expectsJson: true,
  id: "certificate_extraction",
  maxInputChars: CERTIFICATE_MAX_INPUT_CHARS,
  maxOutputTokens: CERTIFICATE_MAX_OUTPUT_TOKENS,
  mock: (input) => JSON.stringify(mockCertificateFields(input)),
  promptVersion: "certificate_extraction@1",
  systemPrompt: CERTIFICATE_PROMPT,
  validate: validateCertificateFields,
});
