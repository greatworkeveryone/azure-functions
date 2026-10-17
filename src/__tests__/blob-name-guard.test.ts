/// <reference types="jest" />

// SEC-01: the storage SDK resolves "." and ".." segments when it builds a blob
// URL, so a crafted name addresses another container. Every name used for a
// delete, a download or a SAS must match the shape the server mints.

const blockClient = { deleteIfExists: jest.fn(), downloadToBuffer: jest.fn(), uploadData: jest.fn(), url: "" };
const containerClient = { createIfNotExists: jest.fn(), getBlockBlobClient: jest.fn(() => blockClient) };

jest.mock("@azure/storage-blob", () => {
  class StorageSharedKeyCredential {}
  return {
    BlobSASPermissions: { parse: jest.fn(() => "r") },
    BlobServiceClient: {
      fromConnectionString: jest.fn(() => ({
        credential: new StorageSharedKeyCredential(),
        getContainerClient: jest.fn(() => containerClient),
        url: "https://acct.blob.core.windows.net/",
      })),
    },
    SASProtocol: { Https: "https", HttpsAndHttp: "https,http" },
    StorageSharedKeyCredential,
    generateBlobSASQueryParameters: jest.fn(() => ({ toString: () => "sig=x" })),
  };
});

import {
  ATTACHMENT_SHAPE,
  BlobNameError,
  BlobNameShape,
  EMAIL_ATTACHMENT_SHAPE,
  INSPECTION_PHOTO_SHAPE,
  KEY_PHOTO_SHAPE,
  PO_PDF_SHAPE,
  VACANCY_SHAPE,
  WR_ATTACHMENTS_SHAPES,
  assertBlobName,
  isBlobName,
} from "../blob-names";
import * as blobStorage from "../blob-storage";

const { generateBlobSASQueryParameters } = jest.requireMock("@azure/storage-blob") as {
  generateBlobSASQueryParameters: jest.Mock;
};

const UUID = "3f2c9a10-5b7e-4d21-9c8a-0e1f2a3b4c5d";

const VALID: [string, BlobNameShape, string][] = [
  ["job upload", ATTACHMENT_SHAPE, `attachments/jobs/12/${UUID}.pdf`],
  ["work-request upload", ATTACHMENT_SHAPE, `attachments/workRequests/7/${UUID}`],
  ["tenancy file", ATTACHMENT_SHAPE, `tenancy-4/${UUID}.docx`],
  ["asset file", ATTACHMENT_SHAPE, `asset-9/${UUID}.png`],
  ["legacy job prefix", ATTACHMENT_SHAPE, `job-3/${UUID}.jpg`],
  ["inspection photo", INSPECTION_PHOTO_SHAPE, `inspections/${UUID}.jpg`],
  ["email attachment", EMAIL_ATTACHMENT_SHAPE, `email-attachments/AAMkAGI2_T-VSAAA=/${UUID}.pdf`],
  ["purchase-order PDF", PO_PDF_SHAPE, "po/55.pdf"],
  ["key photo", KEY_PHOTO_SHAPE, `keys/${UUID}.jpg`],
  ["vacancy image", VACANCY_SHAPE, `12/${UUID}.jpg`],
  ["vacancy slot image", VACANCY_SHAPE, `12/slots/${UUID}.png`],
  ["building hero", VACANCY_SHAPE, `building-hero/3/${UUID}.webp`],
];

const BAD: [string, unknown][] = [
  ["traversal out of the email prefix", "emails/x/../../../key-photos/keys/a.jpg"],
  ["traversal behind a valid email prefix", `email-attachments/x/../../attachments/jobs/12/${UUID}.pdf`],
  ["traversal behind a valid job prefix", `attachments/jobs/12/../../../key-photos/keys/${UUID}.jpg`],
  ["percent-encoded dot segment", "attachments/jobs/12/%2e%2e/x"],
  ["backslash", `attachments\\jobs\\12\\${UUID}.pdf`],
  ["leading slash", `/attachments/jobs/12/${UUID}.pdf`],
  ["empty segment", `attachments/jobs//${UUID}.pdf`],
  ["single-dot segment", `attachments/jobs/12/./${UUID}.pdf`],
  ["NUL control character", `attachments/jobs/12/${UUID}\u0000.pdf`],
  ["newline control character", `attachments/jobs/12/${UUID}.pdf\n`],
  ["vacancy URL traversal", `../wr-attachments/attachments/jobs/12/${UUID}.pdf`],
  ["double extension", `attachments/jobs/12/${UUID}.pdf.html`],
  ["trailing slash", `attachments/jobs/12/${UUID}.pdf/`],
  ["empty string", ""],
  ["non-string", 42],
  ["undefined", undefined],
];

const ALL_SHAPES: [string, BlobNameShape | readonly BlobNameShape[]][] = [
  ["ATTACHMENT_SHAPE", ATTACHMENT_SHAPE],
  ["INSPECTION_PHOTO_SHAPE", INSPECTION_PHOTO_SHAPE],
  ["EMAIL_ATTACHMENT_SHAPE", EMAIL_ATTACHMENT_SHAPE],
  ["PO_PDF_SHAPE", PO_PDF_SHAPE],
  ["KEY_PHOTO_SHAPE", KEY_PHOTO_SHAPE],
  ["VACANCY_SHAPE", VACANCY_SHAPE],
  ["WR_ATTACHMENTS_SHAPES", WR_ATTACHMENTS_SHAPES],
];

describe("assertBlobName", () => {
  it.each(VALID)("accepts a minted %s name", (_label, shape, name) => {
    expect(assertBlobName(name, shape)).toBe(name);
    expect(isBlobName(name, shape)).toBe(true);
  });

  describe.each(ALL_SHAPES)("%s", (_shapeLabel, shape) => {
    it.each(BAD)("rejects %s", (_label, name) => {
      expect(() => assertBlobName(name, shape)).toThrow(BlobNameError);
      expect(isBlobName(name, shape)).toBe(false);
    });
  });

  it("does not let one container's name pass as another's", () => {
    expect(() => assertBlobName(`keys/${UUID}.jpg`, WR_ATTACHMENTS_SHAPES)).toThrow(BlobNameError);
    expect(() => assertBlobName(`attachments/jobs/12/${UUID}.pdf`, VACANCY_SHAPE)).toThrow(BlobNameError);
    expect(() => assertBlobName(`inspections/${UUID}.jpg`, ATTACHMENT_SHAPE)).toThrow(BlobNameError);
  });

  it("anchors the email claim to the real mail-sync prefix", () => {
    expect(isBlobName(`emails/AAMk/${UUID}.pdf`, EMAIL_ATTACHMENT_SHAPE)).toBe(false);
    expect(isBlobName(`email-attachments/AAMk/${UUID}.pdf`, EMAIL_ATTACHMENT_SHAPE)).toBe(true);
  });
});

describe("blob-storage helpers refuse bad names before touching storage", () => {
  const saved = process.env.AzureWebJobsStorage;
  beforeAll(() => {
    process.env.AzureWebJobsStorage = "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=a2V5;EndpointSuffix=core.windows.net";
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.AzureWebJobsStorage;
    else process.env.AzureWebJobsStorage = saved;
  });
  beforeEach(() => jest.clearAllMocks());

  const badNames = BAD.map(([label, name]) => [label, name as string] as const);

  it.each(badNames)("deleteBlob rejects %s", async (_label, name) => {
    await expect(blobStorage.deleteBlob(name)).rejects.toThrow(BlobNameError);
    expect(containerClient.getBlockBlobClient).not.toHaveBeenCalled();
  });

  it.each(badNames)("downloadBlob rejects %s", async (_label, name) => {
    await expect(blobStorage.downloadBlob(name)).rejects.toThrow(BlobNameError);
    expect(containerClient.getBlockBlobClient).not.toHaveBeenCalled();
  });

  it.each(badNames)("deletePublicBlob rejects %s", async (_label, name) => {
    await expect(blobStorage.deletePublicBlob(name)).rejects.toThrow(BlobNameError);
    expect(containerClient.getBlockBlobClient).not.toHaveBeenCalled();
  });

  it.each(badNames)("generateReadSasUrl rejects %s", (_label, name) => {
    expect(() => blobStorage.generateReadSasUrl(name)).toThrow(BlobNameError);
    expect(generateBlobSASQueryParameters).not.toHaveBeenCalled();
  });

  it.each(badNames)("keyPhotoReadSasUrl signs nothing for %s", (_label, name) => {
    expect(blobStorage.keyPhotoReadSasUrl(name)).toBeNull();
    expect(generateBlobSASQueryParameters).not.toHaveBeenCalled();
  });

  it("vacanciesReadSasUrl leaves a URL with a bad vacancies name unsigned", () => {
    const url = "https://acct.blob.core.windows.net/vacancies/../wr-attachments/attachments/jobs/12/x.pdf";
    expect(blobStorage.vacanciesReadSasUrl(url)).toBe(url);
    expect(generateBlobSASQueryParameters).not.toHaveBeenCalled();
  });

  it("still serves genuine names", async () => {
    await blobStorage.deleteBlob(`attachments/jobs/12/${UUID}.pdf`);
    await blobStorage.downloadBlob("po/55.pdf");
    await blobStorage.deletePublicBlob(`12/slots/${UUID}.png`);
    expect(containerClient.getBlockBlobClient).toHaveBeenCalledTimes(3);
    expect(blobStorage.generateReadSasUrl(`email-attachments/AAMk/${UUID}.pdf`)).toContain("sig=x");
    expect(blobStorage.keyPhotoReadSasUrl(`keys/${UUID}.jpg`)).toContain("/key-photos/keys/");
    expect(blobStorage.vacanciesReadSasUrl(`https://acct.blob.core.windows.net/vacancies/building-hero/3/${UUID}.png`))
      .toContain("sig=x");
  });

  it("mints a safe vacancy name even when the uploaded file name carries a path", async () => {
    const { blobName } = await blobStorage.uploadPublicBlob(Buffer.from("x"), "a.jpg/../../../wr-attachments/x", "image/jpeg", "12");
    expect(isBlobName(blobName, VACANCY_SHAPE)).toBe(true);
  });
});
