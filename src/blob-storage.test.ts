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
  uploadBlob,
  uploadPublicBlob,
  deletePublicBlob,
  vacanciesReadSasUrl,
  vacanciesBlobNameFromUrl,
  uploadKeyPhotoBlob,
  keyPhotoReadSasUrl,
} from "./blob-storage";

// Names the app actually mints (blob-names.ts): helpers refuse anything else.
const UUID = "3f2c9a10-5b7e-4d21-9c8a-0e1f2a3b4c5d";
const VACANCY_NAME = `42/${UUID}.jpg`;
const KEY_PHOTO_NAME = `keys/${UUID}.png`;

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
    const out = vacanciesReadSasUrl(`${ACCOUNT_BASE}/vacancies/${VACANCY_NAME}`);
    expect(out).toBe(`${ACCOUNT_BASE}/vacancies/${VACANCY_NAME}?sig=fake&c=vacancies`);
  });

  it("leaves a vacancies URL whose name was never minted unsigned", () => {
    const crafted = `${ACCOUNT_BASE}/vacancies/../wr-attachments/x.pdf`;
    expect(vacanciesReadSasUrl(crafted)).toBe(crafted);
  });

  it("passes external / already-signed URLs through unchanged", () => {
    const external = "https://cdn.example.com/x.jpg";
    expect(vacanciesReadSasUrl(external)).toBe(external);
  });
});

describe("deletePublicBlob", () => {
  it("creates the container private and deletes the blob", async () => {
    await deletePublicBlob(VACANCY_NAME);
    expect(createIfNotExistsMock.mock.calls[0][0]).toBeUndefined();
    expect(deleteIfExistsMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a name that was never minted, before touching storage", async () => {
    await expect(deletePublicBlob("42/../../wr-attachments/x.pdf")).rejects.toThrow(/Rejected blob name/);
    expect(deleteIfExistsMock).not.toHaveBeenCalled();
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
    // The regression this guards: must NOT land in the wr-attachments
    // container — key photos are permanent evidence and stay isolated from it.
    expect(result.url).toContain("/key-photos/");
    expect(result.url).not.toContain("/wr-attachments/");
  });
});

describe("keyPhotoReadSasUrl", () => {
  it("mints a read SAS against the key-photos container", () => {
    const out = keyPhotoReadSasUrl(KEY_PHOTO_NAME);
    expect(out).toBe(`${ACCOUNT_BASE}/key-photos/${KEY_PHOTO_NAME}?sig=fake&c=key-photos`);
  });

  it("gives no URL for a name that was never minted", () => {
    expect(keyPhotoReadSasUrl("keys/../wr-attachments/x.pdf")).toBeNull();
  });
});

describe("uploadBlob → disposition and stored type", () => {
  const headersOf = (): { blobContentType: string; blobContentDisposition: string } =>
    uploadDataMock.mock.calls[0][1].blobHTTPHeaders;

  it("serves images and PDFs inline with the normalised type", async () => {
    await uploadBlob(Buffer.from("x"), "a b.pdf", "Application/PDF; charset=x", "attachments/jobs/1");
    expect(headersOf().blobContentType).toBe("application/pdf");
    expect(headersOf().blobContentDisposition).toBe("inline; filename*=UTF-8''a%20b.pdf");
  });

  it("forces download for allowlisted non-image types", async () => {
    await uploadBlob(Buffer.from("x"), "n.txt", "text/plain", "attachments/jobs/1");
    expect(headersOf().blobContentType).toBe("text/plain");
    expect(headersOf().blobContentDisposition.startsWith("attachment;")).toBe(true);
  });

  it.each(["image/svg+xml", "image/svg+xml; charset=utf-8", "text/html", "application/octet-stream"])(
    "stores %s as octet-stream attachment",
    async (type) => {
      await uploadBlob(Buffer.from("x"), "e'v(il).svg", type, "attachments/jobs/1");
      expect(headersOf().blobContentType).toBe("application/octet-stream");
      expect(headersOf().blobContentDisposition).toBe("attachment; filename*=UTF-8''e%27v%28il%29.svg");
    },
  );
});
