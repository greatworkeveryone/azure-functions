import { categoryFromText, laneFor, rulesWork, toddlerWork, urgencyFromText } from "./workInference";

describe("rulesWork", () => {
  it("reads a repair request as maintenance, with its category, for the facilities lane", () => {
    const work = rulesWork("Leak in the kitchen", "Water is leaking from the ceiling above the sink.");
    expect(work).toMatchObject({ category: "Hydraulic", intent: "maintenance_request", lane: "facilities", source: "rules" });
  });

  it("reads an invoice or a rent question as accounts work", () => {
    expect(rulesWork("Invoice 4471 attached", "Please find our invoice for payment.")).toMatchObject({ intent: "invoice_or_quote", lane: "accounts" });
    expect(rulesWork("Rent statement", "Can you confirm what is overdue on our account?")).toMatchObject({ intent: "rent_or_account", lane: "accounts" });
  });

  it("gives a quote to both teams and anything unreadable to both", () => {
    expect(rulesWork("Quote for the lift service", "Our quotation is attached.")).toMatchObject({ intent: "invoice_or_quote", lane: "both" });
    expect(rulesWork("Hello", "Just saying hi.")).toMatchObject({ category: null, intent: "other", lane: "both", urgency: null });
  });

  it("reads a complaint and how urgent the email sounds", () => {
    expect(rulesWork("Complaint", "This is unacceptable service.").intent).toBe("complaint");
    expect(urgencyFromText("there is a gas leak")).toBe("urgent");
    expect(urgencyFromText("please reply asap")).toBe("high");
    expect(urgencyFromText("when you can")).toBeNull();
  });

  it("only reads the start of a long body", () => {
    expect(rulesWork("Hi", `${"x ".repeat(1000)} the lift is broken`).intent).toBe("other");
  });

  it("picks the category the text speaks of most", () => {
    expect(categoryFromText("lift lift lift and one tap")).toBe("Lifts");
    expect(categoryFromText("nothing relevant")).toBeNull();
  });
});

describe("laneFor", () => {
  it("sends maintenance to facilities, money to accounts, a quote and the rest to both", () => {
    expect(laneFor("maintenance_request")).toBe("facilities");
    expect(laneFor("invoice_or_quote")).toBe("accounts");
    expect(laneFor("rent_or_account")).toBe("accounts");
    expect(laneFor("invoice_or_quote", true)).toBe("both");
    expect(laneFor("complaint")).toBe("both");
    expect(laneFor("other")).toBe("both");
  });
});

describe("toddlerWork", () => {
  const rules = rulesWork("Air con not working", "It is too hot");

  it("uses Toddler's classification as it stands, with its priority and job reference", () => {
    const work = toddlerWork("job", JSON.stringify({ buildingName: "Frogmore House", jobRef: "Job #42", priority: "High" }), rules);
    expect(work).toMatchObject({ buildingName: "Frogmore House", category: "HVAC / mechanical", intent: "maintenance_request", jobNumber: 42, lane: "facilities", source: "toddler", urgency: "high" });
  });

  it("maps invoices to accounts and quotes to both teams", () => {
    expect(toddlerWork("invoice", null, rules)).toMatchObject({ intent: "invoice_or_quote", lane: "accounts" });
    expect(toddlerWork("quote", null, rules)).toMatchObject({ intent: "invoice_or_quote", lane: "both" });
  });

  it("asks the next source when Toddler said unknown, said nothing, or flagged the email as suspicious", () => {
    expect(toddlerWork("unknown", null, rules)).toBeNull();
    expect(toddlerWork(null, null, rules)).toBeNull();
    expect(toddlerWork("job", JSON.stringify({ suspicious: true }), rules)).toBeNull();
  });

  it("copes with unreadable parsed data", () => {
    expect(toddlerWork("job", "{not json", rules)).toMatchObject({ intent: "maintenance_request", jobNumber: null });
  });
});
