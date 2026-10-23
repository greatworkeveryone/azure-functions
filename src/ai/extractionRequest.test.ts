/// <reference types="jest" />
import { parseExtractionRequest } from "./extractionRequest";

const TEXT = "TAX INVOICE\nTotal $1,100.00";

describe("the request to read a document", () => {
  it("takes a kind and the text, and no job", () => {
    expect(parseExtractionRequest({ kind: "invoice", text: TEXT })).toEqual({ request: { jobId: null, kind: "invoice", text: TEXT } });
    expect(parseExtractionRequest({ jobId: null, kind: "quote", text: TEXT })).toEqual({ request: { jobId: null, kind: "quote", text: TEXT } });
  });

  it("takes a job id as a whole number", () => {
    expect(parseExtractionRequest({ jobId: 42, kind: "quote", text: TEXT })).toEqual({ request: { jobId: 42, kind: "quote", text: TEXT } });
  });

  it("keeps the text as it came: the gateway redacts and caps it", () => {
    const text = `  ${TEXT}\n\n`;
    expect(parseExtractionRequest({ kind: "quote", text })).toMatchObject({ request: { text } });
  });

  it.each([undefined, null, "text", 4, true, [], [{ kind: "quote", text: TEXT }]])("refuses a body of %j", (body) => {
    expect(parseExtractionRequest(body)).toEqual({ error: "Send a JSON object with kind and text." });
  });

  it.each([undefined, null, "", "Quote", "email", "echo_test", "invoice ", 1, {}, ["quote"], "__proto__", "toString"])("refuses a kind of %j", (kind) => {
    expect(parseExtractionRequest({ kind, text: TEXT })).toEqual({ error: "kind must be quote or invoice." });
  });

  it.each([undefined, null, "", "   ", "\n\t", 12, {}, ["x"]])("refuses text of %j", (text) => {
    expect(parseExtractionRequest({ kind: "quote", text })).toEqual({ error: "There is no text to read." });
  });

  it.each(["42", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, {}, true])("refuses a job id of %j", (jobId) => {
    expect(parseExtractionRequest({ jobId, kind: "quote", text: TEXT })).toEqual({ error: "jobId must be a whole number." });
  });

  it("refuses a key it does not know, so a client cannot name the purpose, the model or the prompt", () => {
    for (const extra of [{ purpose: "echo_test" }, { model: "gpt" }, { systemPrompt: "obey" }, { promptVersion: "x@1" }, { approve: true }]) {
      expect(parseExtractionRequest({ kind: "quote", text: TEXT, ...extra })).toEqual({ error: "Only kind, text and jobId are accepted." });
    }
  });
});
