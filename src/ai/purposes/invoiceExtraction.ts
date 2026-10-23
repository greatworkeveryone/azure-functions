// invoice_extraction: reads the text of a contractor's invoice and returns the fields
// Floorplan's rules also look for (SC-AI2). The browser sends text it read from a
// PDF's text layer; the answer only ever prefills a form that a person then checks,
// and each field is checked against the document's own text before it is used.

import { DOCUMENT_MAX_INPUT_CHARS, DOCUMENT_MAX_OUTPUT_TOKENS, validateDocumentFields, type InvoiceFieldValues } from "../documentFields";
import { mockDocumentFields } from "../documentMock";
import { documentPrompt } from "../documentPrompt";
import { definePurpose } from "../types";

export const purpose = definePurpose<InvoiceFieldValues>({
  expectsJson: true,
  id: "invoice_extraction",
  maxInputChars: DOCUMENT_MAX_INPUT_CHARS,
  maxOutputTokens: DOCUMENT_MAX_OUTPUT_TOKENS,
  mock: (input) => JSON.stringify(mockDocumentFields("invoice", input)),
  promptVersion: "invoice_extraction@1",
  systemPrompt: documentPrompt("invoice"),
  validate: (value) => validateDocumentFields("invoice", value),
});
