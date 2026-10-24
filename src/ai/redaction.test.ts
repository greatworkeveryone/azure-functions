/// <reference types="jest" />
import { isAbnValid, isLuhnValid, isTfnValid } from "./checksums";
import { redactText } from "./redaction";

// Each kind of personal detail the gateway replaces before a provider sees text,
// and, for each, what is deliberately left alone. A false positive here costs a
// field an extraction needs (an ABN, an invoice number); a false negative leaks.

const redact = (text: string) => redactText(text).text;
const kinds = (text: string) => Object.fromEntries(Object.entries(redactText(text).byKind).filter(([, n]) => n > 0));

describe("checksums", () => {
  it("accepts the published sample numbers and refuses a changed digit", () => {
    expect(isAbnValid("51824753556")).toBe(true);
    expect(isAbnValid("51824753557")).toBe(false);
    expect(isTfnValid("123456782")).toBe(true);
    expect(isTfnValid("123456789")).toBe(false);
    expect(isLuhnValid("4111111111111111")).toBe(true);
    expect(isLuhnValid("4111111111111112")).toBe(false);
  });

  it("refuses the wrong length or non-digits instead of guessing", () => {
    expect(isAbnValid("5182475355")).toBe(false);
    expect(isTfnValid("12345678")).toBe(false);
    expect(isTfnValid("12345678x")).toBe(false);
    expect(isLuhnValid("")).toBe(false);
  });
});

describe("email addresses", () => {
  it.each([
    ["Contact jo.bloggs@example.com.au for access", "Contact [EMAIL] for access"],
    ["a+tag@sub.domain.example.org,", "[EMAIL],"],
    ["<accounts@randazzo.example>", "<[EMAIL]>"],
    ["mailto:ops_team-1@x-y.co", "mailto:[EMAIL]"],
  ])("replaces the address in %j", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("counts every address", () => {
    expect(redactText("a@b.co and c@d.co").count).toBe(2);
    expect(kinds("a@b.co and c@d.co")).toEqual({ email: 2 });
  });

  it.each([
    ["an @mention", "Thanks @carlo, see you then"],
    ["an address with no domain", "send it to jo@ today"],
    ["a name at a place with no dot", "user@localhost"],
    ["a 'meet @ time'", "meet @ 3pm at the depot"],
    ["a bare domain", "see example.com.au for details"],
    ["a one-letter top level", "a@b.c"],
  ])("leaves %s alone", (_label, input) => {
    expect(redact(input)).toBe(input);
  });
});

describe("Australian phone numbers", () => {
  it.each([
    "0412 345 678",
    "0412-345-678",
    "0412345678",
    "04 1234 5678",
    "+61 412 345 678",
    "+61412345678",
    "+61 (0)412 345 678",
    "+61-4-1234-5678",
  ])("replaces the mobile %s", (number) => {
    expect(redact(`Call ${number} after 5.`)).toBe("Call [PHONE] after 5.");
  });

  it.each([
    "(08) 8941 2345",
    "(08)89412345",
    "08 8941 2345",
    "08-8941-2345",
    "08 89412345",
    "(02) 9876 5432",
    "03 9123 4567",
    "07 3000 1234",
    "+61 8 8941 2345",
    "+61889412345",
    "+61 (0)8 8941 2345",
  ])("replaces the landline %s", (number) => {
    expect(redact(`Office: ${number}.`)).toBe("Office: [PHONE].");
  });

  it.each(["1300 123 456", "1800-123-456"])("replaces the service number %s", (number) => {
    expect(redact(`Ring ${number} now`)).toBe("Ring [PHONE] now");
  });

  it("replaces a number given a label, whatever its shape, such as a Darwin number with no area code", () => {
    expect(redact("Ph: 8941 2345")).toBe("Ph: [PHONE]");
    expect(redact("Phone no. 89412345 (reception)")).toBe("Phone no. [PHONE] (reception)");
    expect(redact("Fax - 08 8941 2346")).toBe("Fax - [PHONE]");
    expect(redact("mobile 0412 345 678")).toBe("mobile [PHONE]");
  });

  it.each([
    ["P: 8981 1234", "P: [PHONE]"],
    ["p: 89811234", "p: [PHONE]"],
    ["F: 8981 2345", "F: [PHONE]"],
    ["T: 08 8981 1234 | M: 0412 345 678", "T: [PHONE] | M: [PHONE]"],
    ["M: 8981 1234", "M: [PHONE]"],
    ["Darwin office P. 8981 1234", "Darwin office P. [PHONE]"],
    ["jo@example.com | P: 8981 1234 | E: x", "[EMAIL] | P: [PHONE] | E: x"],
  ])("replaces the number after a one-letter label in %j", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it.each([
    ["a page of a document", "P: 12 of 40"],
    ["a time", "T: 08:30 start"],
    ["a measurement", "M: 4.5 kg"],
    ["a number too short to be a phone", "P: 1234567"],
    ["a number too long to be a phone", "F: 12345678901234"],
    ["a letter inside a word", "Step 8981 1234 and APT: 8981 1234x"],
    ["a label with no number", "P: see the invoice"],
  ])("leaves %s alone", (_label, input) => {
    expect(redact(input)).toBe(input);
  });

  it("keeps the words around the number and counts it once", () => {
    const result = redactText("Ph: 08 8941 2345 or 0412 345 678");
    expect(result.text).toBe("Ph: [PHONE] or [PHONE]");
    expect(result.count).toBe(2);
  });

  it.each([
    ["a bare landline-shaped number (as often an invoice number)", "Invoice 0889412345 is overdue"],
    ["a bare 1300 number", "Reference 1300123456"],
    ["a ten-digit number with another start", "Order 1234567890 shipped"],
    ["a mobile glued to letters", "Ref INV0412345678"],
    ["a mobile in a hyphenated id", "Job-0412345678"],
    ["an amount", "Total $1,300.00 incl GST $118.18"],
    ["a postcode", "Darwin NT 0800"],
    ["a date", "Due 23/10/2026 (2026-10-23)"],
    ["a short label and a small number", "Phone 3 of 5 units"],
    ["pH", "Water pH 7.4 at 25 degrees"],
    ["a label inside a longer word", "Hotel 8941 2345 rooms"],
  ])("leaves %s alone", (_label, input) => {
    expect(redact(input)).toBe(input);
  });
});

describe("BSB and account numbers", () => {
  it.each([
    ["BSB: 063-000", "BSB: [BSB]"],
    ["BSB 063 000", "BSB [BSB]"],
    ["BSB number 063000", "BSB number [BSB]"],
    ["bsb no. 013-000", "bsb no. [BSB]"],
  ])("replaces the BSB in %j", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it.each([
    ["Account: 12345678", "Account: [ACCOUNT]"],
    ["Acc No 1234 5678", "Acc No [ACCOUNT]"],
    ["Acct #123-456-789", "Acct #[ACCOUNT]"],
    ["account number 123456789", "account number [ACCOUNT]"],
    ["Acct. No. 12345678", "Acct. No. [ACCOUNT]"],
    ["Acc. no 1234 5678", "Acc. no [ACCOUNT]"],
    ["A/C no: 12345678", "A/C no: [ACCOUNT]"],
    ["A/C: 12345678", "A/C: [ACCOUNT]"],
  ])("replaces the account number in %j", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("replaces a hyphenated BSB followed by an account number, with or without labels", () => {
    expect(redact("Pay 063-000 12345678 by Friday")).toBe("Pay [BSB] [ACCOUNT] by Friday");
    expect(redact("BSB: 063-000, 12345678")).toBe("BSB: [BSB], [ACCOUNT]");
    expect(redact("Bank: BSB 063 000 Acc 12345678")).toBe("Bank: BSB [BSB] Acc [ACCOUNT]");
    expect(kinds("Pay 063-000 12345678")).toEqual({ account: 1, bsb: 1 });
  });

  it.each([
    ["an unlabelled number", "Quote 12345678 for the lift"],
    ["a short number after 'account'", "Account 12 of the schedule"],
    ["air conditioning", "A/C unit 123456 serviced"],
    ["the word accounts", "Accounts 12345678 queue"],
    ["a hyphenated pair that is not followed by an account", "Part 063-000 in stock"],
    ["a label with no digits", "BSB and account details are on the invoice"],
  ])("leaves %s alone", (_label, input) => {
    expect(redact(input)).toBe(input);
  });
});

describe("BSB and account number together, as bank details are really written (review: redaction misses)", () => {
  it.each([
    ["Bank: CBA 062-000 1234 5678", "Bank: CBA [BSB] [ACCOUNT]"],
    ["062 000 1234 5678", "[BSB] [ACCOUNT]"],
    ["EFT: 062000 12345678", "EFT: [BSB] [ACCOUNT]"],
    ["Pay 062 000 1234 5678 by Friday", "Pay [BSB] [ACCOUNT] by Friday"],
    ["Pay 062\u00a0000\u00a01234\u00a05678 by Friday", "Pay [BSB]\u00a0[ACCOUNT] by Friday"],
    ["062 000 12345678", "[BSB] [ACCOUNT]"],
    ["Pay 062-000 1234 5678", "Pay [BSB] [ACCOUNT]"],
    ["Pay 063-000 123 456 789", "Pay [BSB] [ACCOUNT]"],
    ["Direct credit to Westpac 033-123 456 789", "Direct credit to Westpac [BSB] [ACCOUNT]"],
    ["Deposit: 062 000 12345678 ref INV-0042", "Deposit: [BSB] [ACCOUNT] ref INV-0042"],
    ["Banking details: ANZ 013000 123456789", "Banking details: ANZ [BSB] [ACCOUNT]"],
    ["Bank details: Commonwealth Bank of Australia, 062 000, 1234 5678", "Bank details: Commonwealth Bank of Australia, [BSB], [ACCOUNT]"],
    ["Remittance: 062000 1234 5678", "Remittance: [BSB] [ACCOUNT]"],
    ["BSB 062-000 Account 1234 5678", "BSB [BSB] Account [ACCOUNT]"],
    ["Account: 062-000 1234 5678", "Account: [BSB] [ACCOUNT]"],
  ])("replaces both in %j", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("counts a BSB and its account as two details", () => {
    expect(kinds("EFT: 062000 12345678")).toEqual({ account: 1, bsb: 1 });
    expect(kinds("062 000 1234 5678")).toEqual({ account: 1, bsb: 1 });
  });

  it("keeps the supplier's ABN beside the bank details", () => {
    expect(redact("ABN 51 824 753 556 | EFT: 062000 12345678")).toBe("ABN 51 824 753 556 | EFT: [BSB] [ACCOUNT]");
    expect(redact("Supplier 51 824 753 556. Bank: CBA 062-000 1234 5678")).toBe("Supplier 51 824 753 556. Bank: CBA [BSB] [ACCOUNT]");
  });

  it.each([
    ["an invoice with a spaced date and amount", "Invoice INV-2026-0042 dated 23 10 2026, total $1 062.00 incl GST $96.55"],
    ["a quote number that is only a BSB's length", "Quote 062 000 123 for the lift"],
    ["three groups of four", "Order 1234 5678 9012 shipped"],
    ["a part number", "Part 063-000 in stock"],
    ["a run-together pair with no bank label", "Ref 062000 12345678"],
    ["an amount in spaced thousands", "Total 1 234 567 890 over the term"],
    ["a dollar amount", "Total $1,062,000.00 incl GST"],
    ["a date and a time", "Dated 23 10 2026 14 05"],
    ["a three-three-four reference", "Receipt 123 456 7890"],
    ["a long grouped number that is no bank detail", "Reference 123 456 789 012 345 678"],
    ["two phone numbers", "Ph 08 8941 2345 or 0412 345 678"],
    ["a postcode and a state", "Darwin NT 0800 062 000"],
    ["a bank name alone", "Bank holiday trading hours apply"],
    ["a label with no numbers", "EFT: details on the invoice"],
  ])("leaves %s alone", (_label, input) => {
    const result = redactText(input);
    expect(result.byKind.bsb).toBe(0);
    expect(result.byKind.account).toBe(0);
    expect(result.text).toBe(input.replace("Ph 08 8941 2345 or 0412 345 678", "Ph [PHONE] or [PHONE]"));
  });
});

describe("tax file numbers", () => {
  it.each([
    ["TFN: 123 456 782", "TFN: [TFN]"],
    ["TFN 123456782", "TFN [TFN]"],
    ["tfn 12345678", "tfn [TFN]"],
    ["Tax file number 123-456-789", "Tax file number [TFN]"],
    ["tax file no. 876 543 210", "tax file no. [TFN]"],
  ])("replaces a labelled TFN in %j, whatever its checksum", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("does not take the end of a longer run of groups for a TFN", () => {
    expect(isTfnValid("123456782")).toBe(true);
    expect(redact("Reference 99 111 123 456 782")).toBe("Reference 99 111 123 456 782");
    expect(redact("Reference 2026 123 456 782")).toBe("Reference 2026 123 456 782");
  });

  it("replaces an unlabelled TFN only when it is grouped 3-3-3 and passes the checksum", () => {
    expect(redact("Declared 123 456 782 yesterday")).toBe("Declared [TFN] yesterday");
    expect(redact("Declared 876-543-210 yesterday")).toBe("Declared [TFN] yesterday");
    expect(redact("Declared 123 456 789 yesterday")).toBe("Declared 123 456 789 yesterday");
    expect(redact("Declared 123456782 yesterday")).toBe("Declared 123456782 yesterday");
  });
});

describe("card numbers", () => {
  it.each([
    ["Visa", "4111 1111 1111 1111"],
    ["Visa, unspaced", "4111111111111111"],
    ["Visa, hyphens", "4111-1111-1111-1111"],
    ["Mastercard", "5500 0000 0000 0004"],
    ["Amex", "3782 822463 10005"],
    ["Diners", "3056 930902 5904"],
    ["Discover", "6011 1111 1111 1117"],
    ["JCB", "3530 1113 3330 0000"],
  ])("replaces a %s number that passes Luhn", (_label, number) => {
    expect(redact(`Card ${number} exp 12/26`)).toBe("Card [CARD] exp 12/26");
  });

  it("finds a card followed by its expiry or security code without taking them", () => {
    expect(redact("4111 1111 1111 1111 12/26")).toBe("[CARD] 12/26");
    expect(redact("4111111111111111 12 26")).toBe("[CARD] 12 26");
    expect(redact("4111 1111 1111 1111 123")).toBe("[CARD] 123");
  });

  it("finds two cards in one run", () => {
    expect(redactText("4111111111111111, 5500000000000004").count).toBe(2);
  });

  it.each([
    ["a 16-digit number that fails Luhn", "4111 1111 1111 1112"],
    ["a Luhn-valid number no card issuer uses", "1234567890123452"],
    ["another Luhn-valid number with an unused start", "7123456789012342"],
    ["a 12-digit number", "4111 1111 1111"],
    ["a timestamp", "scan_20261023120003.pdf"],
    ["a 20-digit contiguous number", "41111111111111111111"],
    ["an ABN", "ABN 51 824 753 556"],
  ])("leaves %s alone", (_label, input) => {
    expect(redact(input)).toBe(input);
  });
});

describe("business numbers are kept", () => {
  it.each([
    "ABN 51 824 753 556",
    "ABN: 51824753556",
    "A.B.N. 51 824 753 556",
    "ACN 004 085 616",
    "Australian Business Number 51 824 753 556",
    "ABN 12 345 678 901",
    "Tax invoice 51 824 753 556",
  ])("keeps the number in %j", (input) => {
    expect(redact(input)).toBe(input);
    expect(redactText(input).count).toBe(0);
  });

  it("keeps a valid ABN even where it contains a run that passes the TFN checksum on its own", () => {
    // 867 753 556 passes the TFN checksum by itself; it is the tail of an ABN, so it stays.
    expect(isAbnValid("10867753556")).toBe(true);
    expect(isTfnValid("867753556")).toBe(true);
    expect(redact("Supplier 10 867 753 556")).toBe("Supplier 10 867 753 556");
    expect(redact("Supplier 10 867 753 556 and TFN 867 753 556")).toBe("Supplier 10 867 753 556 and TFN [TFN]");
  });

  it("still redacts a personal detail sitting beside an ABN", () => {
    expect(redact("ABN 51 824 753 556, Ph 08 8941 2345, jo@example.com")).toBe("ABN 51 824 753 556, Ph [PHONE], [EMAIL]");
  });
});

describe("what is left of an invoice", () => {
  it("keeps the numbers an extraction needs: document number, dates, totals and GST", () => {
    const invoice =
      "TAX INVOICE INV-2026-0042 dated 23/10/2026. Supplier ABN 51 824 753 556. Subtotal $1,121.00, GST $112.10, Total $1,233.10 due 22/11/2026.";
    expect(redact(invoice)).toBe(invoice);
  });
});

describe("how redaction behaves", () => {
  const sample = "Jo (jo@example.com, 0412 345 678, TFN 123 456 782) paid by 4111 1111 1111 1111 to BSB 063-000 Acc 12345678.";

  it("is the same on every run and changes nothing the second time", () => {
    const once = redactText(sample);
    expect(redactText(sample)).toEqual(once);
    expect(redactText(once.text)).toMatchObject({ count: 0, text: once.text });
  });

  it("counts every replacement, by kind", () => {
    const result = redactText(sample);
    expect(result.text).toBe("Jo ([EMAIL], [PHONE], TFN [TFN]) paid by [CARD] to BSB [BSB] Acc [ACCOUNT].");
    expect(result.count).toBe(6);
    expect(result.byKind).toEqual({ account: 1, bsb: 1, card: 1, email: 1, phone: 1, tfn: 1 });
  });

  it("gives back text with nothing to replace unchanged, and counts none", () => {
    expect(redactText("The lift in Building 7 was serviced on 5 October.")).toMatchObject({ count: 0, text: "The lift in Building 7 was serviced on 5 October." });
    expect(redactText("")).toMatchObject({ count: 0, text: "" });
  });

  it("never replaces one stretch twice when two rules match it", () => {
    // 'Account 0412345678' is both a labelled account and a mobile: one replacement, by the earlier rule.
    expect(redactText("Account 0412345678")).toMatchObject({ count: 1, text: "Account [ACCOUNT]" });
  });

  it("handles non-breaking spaces and a number split across lines the same way", () => {
    expect(redact("Call 0412 345 678")).toBe("Call [PHONE]");
    expect(redact("0412 345\n678")).toBe("0412 345\n678");
  });
});

describe("hostile input costs time in proportion to its length", () => {
  const LONG = 100_000;
  it.each([
    ["one long word", "a".repeat(LONG)],
    ["a long local part", `${"a".repeat(LONG)}@`],
    ["many @", "@".repeat(LONG)],
    ["many addresses", "a@b.co ".repeat(LONG / 7)],
    ["one long digit run", "1".repeat(LONG)],
    ["alternating digits and spaces", "1 ".repeat(LONG / 2)],
    ["labels with long gaps", `Ph${" ".repeat(LONG)}1`],
    ["repeated labels", "ph ".repeat(LONG / 3)],
    ["many ABNs", "51 824 753 556 ".repeat(LONG / 15)],
    ["many hyphens", "1-".repeat(LONG / 2)],
  ])("%s", (_label, text) => {
    const started = Date.now();
    redactText(text);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
