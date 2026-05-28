import {
  defaultLeaseAdministration,
  normaliseLeaseAdministration,
  parseLeaseAdministration,
} from "../leaseAdministrationLogic";

describe("parseLeaseAdministration", () => {
  it("seeds default field lists for null/undefined/empty", () => {
    for (const input of [null, undefined, ""]) {
      const result = parseLeaseAdministration(input);
      expect(result.leaseDocuments).toEqual([]);
      expect(result.leaseManager).toBeNull();
      expect(result.otherDocuments.map((field) => field.id)).toEqual([
        "carParkLicence",
        "roofTopLicence",
        "signageLicence",
        "otherLicences",
        "certOfOccupancy",
        "cocInsurance",
      ]);
      expect(result.detailsEntered.map((field) => field.label)).toContain("MYOB card");
    }
  });

  it("seeds defaults for malformed JSON", () => {
    expect(parseLeaseAdministration("{not json").otherDocuments).toHaveLength(6);
  });

  it("round-trips the new array shape", () => {
    const full = {
      leaseDocuments: [
        { id: "d1", displayOrder: 0, docType: "Amendment of a Lease", scannedToFile: true },
      ],
      otherDocuments: [
        { id: "f1", displayOrder: 0, label: "Car Park Licence", fieldType: "date", value: "2014-07-28" },
      ],
      detailsEntered: [
        { id: "f2", displayOrder: 0, label: "Checked by", fieldType: "text", value: "PT" },
      ],
      leaseManager: { name: "Carlo", email: "carlo@example.com" },
    };
    expect(parseLeaseAdministration(JSON.stringify(full))).toEqual(full);
  });

  it("migrates the legacy fixed-object shape, merging values by key", () => {
    const legacy = {
      otherDocuments: { carParkLicence: "2014-07-28", roofTopLicence: "n/a" },
      detailsEntered: { checkedBy: "PT" },
    };
    const result = parseLeaseAdministration(JSON.stringify(legacy));
    const carPark = result.otherDocuments.find((field) => field.id === "carParkLicence");
    const roof = result.otherDocuments.find((field) => field.id === "roofTopLicence");
    const checkedBy = result.detailsEntered.find((field) => field.id === "checkedBy");
    expect(carPark?.value).toBe("2014-07-28");
    expect(roof?.value).toBe("n/a");
    expect(checkedBy?.value).toBe("PT");
    // unspecified defaults still present, without a value
    expect(result.otherDocuments).toHaveLength(6);
  });
});

describe("normaliseLeaseAdministration", () => {
  it("drops a lease manager that lacks an email", () => {
    expect(normaliseLeaseAdministration({ leaseManager: { name: "Carlo" } }).leaseManager).toBeNull();
  });

  it("preserves an explicitly empty field list (user deleted all rows)", () => {
    const result = normaliseLeaseAdministration({ otherDocuments: [], detailsEntered: [] });
    expect(result.otherDocuments).toEqual([]);
    expect(result.detailsEntered).toEqual([]);
  });

  it("coerces an unknown fieldType to date", () => {
    const result = normaliseLeaseAdministration({
      otherDocuments: [{ id: "f1", label: "X", fieldType: "bogus", displayOrder: 0 }],
    });
    expect(result.otherDocuments[0].fieldType).toBe("date");
  });

  it("coerces non-objects to seeded defaults", () => {
    expect(normaliseLeaseAdministration("nope").otherDocuments).toHaveLength(6);
    expect(normaliseLeaseAdministration(null).leaseDocuments).toEqual([]);
  });
});

describe("defaultLeaseAdministration", () => {
  it("seeds a starter lease document plus the standard fields", () => {
    const seed = defaultLeaseAdministration();
    expect(seed.leaseDocuments).toHaveLength(1);
    expect(seed.leaseDocuments[0].docType).toBe("Original Lease");
    expect(seed.otherDocuments).toHaveLength(6);
    expect(seed.detailsEntered).toHaveLength(4);
    expect(seed.leaseManager).toBeNull();
  });
});
