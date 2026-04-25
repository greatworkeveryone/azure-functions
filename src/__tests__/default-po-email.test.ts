import { describe, test } from "node:test";
import assert from "node:assert";
import { defaultPOEmail } from "../pdf/default-po-email";

const basePO = {
  poNumber: "260419-PO-42-ACM-7",
  contractorName: "Acme Corp",
  scope: "Replace HVAC filters on levels 3–5",
  estimatedCost: 4500,
  costNotToExceed: 5000,
  costJustification: "Scheduled maintenance",
  createdBy: "Will McDonald",
};

const baseJob = {
  jobCode: "RC2600042",
  title: "HVAC maintenance",
  buildingName: "Randazzo Centre",
  levelName: "Level 3",
  exactLocation: "Plant room",
  category: "Maintenance",
  type: "HVAC",
  subType: "Filter",
  contactName: "Jane Smith",
  contactPhone: "0400 000 000",
  contactEmail: "jane@randazzo.properties",
};

describe("defaultPOEmail — subject", () => {
  test("includes PO number and job code + title", () => {
    const { subject } = defaultPOEmail({ po: basePO, job: baseJob });
    assert.ok(subject.includes("260419-PO-42-ACM-7"), "should include PO number");
    assert.ok(subject.includes("RC2600042"), "should include job code");
    assert.ok(subject.includes("HVAC maintenance"), "should include job title");
  });

  test("falls back gracefully when poNumber is null", () => {
    const { subject } = defaultPOEmail({ po: { ...basePO, poNumber: null }, job: baseJob });
    assert.ok(subject.includes("RC2600042"));
  });

  test("falls back gracefully when job code and title are null", () => {
    const { subject } = defaultPOEmail({
      po: basePO,
      job: { ...baseJob, jobCode: null, title: null },
    });
    assert.ok(subject.includes("260419-PO-42-ACM-7"));
    assert.ok(subject.includes("this job"));
  });
});

describe("defaultPOEmail — body", () => {
  test("greets the contractor by name", () => {
    const { body } = defaultPOEmail({ po: basePO, job: baseJob });
    assert.ok(body.startsWith("Hi Acme Corp,"));
  });

  test("falls back to 'team' when contractor name is null", () => {
    const { body } = defaultPOEmail({ po: { ...basePO, contractorName: null }, job: baseJob });
    assert.ok(body.startsWith("Hi team,"));
  });

  test("includes scope of work", () => {
    const { body } = defaultPOEmail({ po: basePO, job: baseJob });
    assert.ok(body.includes("Replace HVAC filters on levels 3–5"));
  });

  test("shows — when scope is null", () => {
    const { body } = defaultPOEmail({ po: { ...basePO, scope: null }, job: baseJob });
    assert.ok(body.includes("Scope of work:\n  —"));
  });

  test("includes estimated cost in AUD", () => {
    const { body } = defaultPOEmail({ po: basePO, job: baseJob });
    assert.ok(body.includes("$4,500.00") || body.includes("4,500"), "should format cost");
  });

  test("includes not-to-exceed in AUD", () => {
    const { body } = defaultPOEmail({ po: basePO, job: baseJob });
    assert.ok(body.includes("$5,000.00") || body.includes("5,000"));
  });

  test("includes building and location", () => {
    const { body } = defaultPOEmail({ po: basePO, job: baseJob });
    assert.ok(body.includes("Randazzo Centre"));
    assert.ok(body.includes("Level 3"));
    assert.ok(body.includes("Plant room"));
  });

  test("includes on-site contact details", () => {
    const { body } = defaultPOEmail({ po: basePO, job: baseJob });
    assert.ok(body.includes("Jane Smith"));
    assert.ok(body.includes("0400 000 000"));
  });

  test("signs off with createdBy", () => {
    const { body } = defaultPOEmail({ po: basePO, job: baseJob });
    assert.ok(body.endsWith("Will McDonald"));
  });

  test("shows — for cost when both cost fields are null", () => {
    const { body } = defaultPOEmail({
      po: { ...basePO, estimatedCost: null, costNotToExceed: null, costJustification: null },
      job: baseJob,
    });
    assert.ok(body.includes("(no cost figures supplied)"));
  });
});
