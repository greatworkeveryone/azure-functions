// Tests for the vacancies/building-gallery blob helpers. The key regression
// guarded here: the container must be created PRIVATE (no `access` option) so
// uploads don't throw `PublicAccessNotPermitted` on a storage account that
// disallows anonymous public access, and image URLs must be served via a
// short-lived read SAS.

// ── Mock @azure/storage-blob ────────────────────────────────────────────────
// A minimal fake that records how containers are created and lets us assert on
// blob URLs + SAS generation without touching Azure / Azurite.

class FakeSharedKeyCredential {
  accountName: string;
  accountKey: string;
  constructor(accountName: string, accountKey: string) {
    this.accountName = accountName;
    this.accountKey = accountKey;
  }
}

const createIfNotExistsMock = jest.fn();
const uploadDataMock = jest.fn();
const deleteIfExistsMock = jest.fn();

const ACCOUNT_BASE = "https://cmctest.blob.core.windows.net";

function makeContainerClient(containerName: string) {
  return {
    createIfNotExists: createIfNotExistsMock,
    getBlockBlobClient: (blobName: string) => ({
      url: `${ACCOUNT_BASE}/${containerName}/${blobName}`,
      uploadData: uploadDataMock,
      deleteIfExists: deleteIfExistsMock,
    }),
  };
}

jest.mock("@azure/storage-blob", () => ({
  BlobSASPermissions: { parse: (p: string) => ({ toString: () => p }) },
  SASProtocol: { Https: "https", HttpsAndHttp: "https,http" },
  StorageSharedKeyCredential: FakeSharedKeyCredential,
  generateBlobSASQueryParameters: jest.fn(
    (opts: { containerName: string; blobName: string }) => ({
      toString: () => `sig=fake&c=${opts.containerName}`,
    }),
  ),
  BlobServiceClient: {
    fromConnectionString: () => ({
      url: `${ACCOUNT_BASE}/`,
      credential: new FakeSharedKeyCredential("cmctest", "key=="),
      getContainerClient: (name: string) => makeContainerClient(name),
    }),
  },
}));

import {
  uploadPublicBlob,
  deletePublicBlob,
  vacanciesReadSasUrl,
  vacanciesBlobNameFromUrl,
  uploadKeyPhotoBlob,
  keyPhotoReadSasUrl,
} from "./blob-storage";

beforeAll(() => {
  process.env.AzureWebJobsStorage =
    "DefaultEndpointsProtocol=https;AccountName=cmctest;AccountKey=key==;EndpointSuffix=core.windows.net";
});

beforeEach(() => {
  createIfNotExistsMock.mockReset();
  uploadDataMock.mockReset();
  deleteIfExistsMock.mockReset();
});

describe("uploadPublicBlob", () => {
  it("creates the container PRIVATE (no public access option) and returns a usable URL", async () => {
    const result = await uploadPublicBlob(
      Buffer.from("img"),
      "photo.jpg",
      "image/jpeg",
      "42",
    );

    // The regression: must NOT request container-level public access.
    expect(createIfNotExistsMock).toHaveBeenCalledTimes(1);
    const arg = createIfNotExistsMock.mock.calls[0][0];
    expect(arg).toBeUndefined();

    expect(uploadDataMock).toHaveBeenCalledTimes(1);
    expect(result.blobName).toMatch(/^42\/.*\.jpg$/);
    expect(result.url).toContain("/vacancies/");
  });

  it("does not throw PublicAccessNotPermitted (private create cannot raise it)", async () => {
    // Simulate the storage account rejecting public access if it were ever
    // requested; private create receives no option, so this guard never fires.
    createIfNotExistsMock.mockImplementation((opts?: { access?: string }) => {
      if (opts?.access) {
        const err = new Error("Public access is not permitted on this storage account.");
        (err as { code?: string }).code = "PublicAccessNotPermitted";
        throw err;
      }
      return Promise.resolve();
    });

    await expect(
      uploadPublicBlob(Buffer.from("x"), "a.png", "image/png", "7"),
    ).resolves.toMatchObject({ blobName: expect.any(String) });
  });
});

describe("vacanciesBlobNameFromUrl", () => {
  it("extracts the blob name from a bare vacancies-container URL", () => {
    expect(
      vacanciesBlobNameFromUrl(`${ACCOUNT_BASE}/vacancies/42/abc.jpg`),
    ).toBe("42/abc.jpg");
  });

  it("strips an existing query string", () => {
    expect(
      vacanciesBlobNameFromUrl(`${ACCOUNT_BASE}/vacancies/42/abc.jpg?sig=old`),
    ).toBe("42/abc.jpg");
  });

  it("returns null for non-vacancies URLs", () => {
    expect(vacanciesBlobNameFromUrl("https://cdn.example.com/x.jpg")).toBeNull();
    expect(vacanciesBlobNameFromUrl("")).toBeNull();
  });
});

describe("vacanciesReadSasUrl", () => {
  it("mints a read SAS URL for a bare vacancies blob URL", () => {
    const out = vacanciesReadSasUrl(`${ACCOUNT_BASE}/vacancies/42/abc.jpg`);
    expect(out).toBe(`${ACCOUNT_BASE}/vacancies/42/abc.jpg?sig=fake&c=vacancies`);
  });

  it("passes external / already-signed URLs through unchanged", () => {
    const external = "https://cdn.example.com/x.jpg";
    expect(vacanciesReadSasUrl(external)).toBe(external);
  });
});

describe("deletePublicBlob", () => {
  it("creates the container private and deletes the blob", async () => {
    await deletePublicBlob("42/abc.jpg");
    expect(createIfNotExistsMock.mock.calls[0][0]).toBeUndefined();
    expect(deleteIfExistsMock).toHaveBeenCalledTimes(1);
  });
});

describe("uploadKeyPhotoBlob", () => {
  it("uploads to the dedicated private key-photos container with a keys/ blob name", async () => {
    const result = await uploadKeyPhotoBlob(Buffer.from("img"), "handover.png", "image/png");

    // Private create (no public-access option) — key photos are never public.
    expect(createIfNotExistsMock).toHaveBeenCalledTimes(1);
    expect(createIfNotExistsMock.mock.calls[0][0]).toBeUndefined();

    expect(uploadDataMock).toHaveBeenCalledTimes(1);
    // Blob-name shape is unchanged from the legacy convention (keys/<uuid>.<ext>)
    // so existing DB values keep the same format — only the container differs.
    expect(result.blobName).toMatch(/^keys\/.*\.png$/);
    // The regression this guards: must NOT land in the transient wr-attachments
    // container that cleanupAttachments reaps.
    expect(result.url).toContain("/key-photos/");
    expect(result.url).not.toContain("/wr-attachments/");
  });
});

describe("keyPhotoReadSasUrl", () => {
  it("mints a read SAS against the key-photos container", () => {
    const out = keyPhotoReadSasUrl("keys/abc.png");
    expect(out).toBe(`${ACCOUNT_BASE}/key-photos/keys/abc.png?sig=fake&c=key-photos`);
  });
});
