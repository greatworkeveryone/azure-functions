import { buildTriageInput } from "./input";
import { mockTriageReading } from "./mock";
import { checkTriageReading } from "./validate";

const read = (subject: string, body: string) => {
  const text = mockTriageReading(buildTriageInput(subject, body));
  const checked = checkTriageReading(JSON.parse(text));
  if (!checked.ok) throw new Error(checked.reason);
  return checked.value;
};

describe("the triage mock", () => {
  it("reads a repair request the way a keyword model would, and names a job number the text names", () => {
    expect(read("Re: Job #42", "The lift is broken again.")).toMatchObject({ category: "Lifts", intent: "maintenance_request", jobNumber: 42 });
  });

  it("reads an invoice, and says nothing about a person", () => {
    const reading = read("Invoice 4471", "Please find our invoice for payment.");
    expect(reading).toMatchObject({ intent: "invoice_or_quote", jobNumber: null });
    expect(Object.keys(reading).sort()).toEqual(["buildingName", "category", "intent", "jobNumber", "tenancyName", "urgency"]);
  });

  it("is deterministic, and its text passes the same checks as a real model's", () => {
    const input = buildTriageInput("Leak", "water everywhere, urgent");
    expect(mockTriageReading(input)).toBe(mockTriageReading(input));
    expect(checkTriageReading(JSON.parse(mockTriageReading(input))).ok).toBe(true);
    expect(checkTriageReading(JSON.parse(mockTriageReading("not an input"))).ok).toBe(true);
  });
});
