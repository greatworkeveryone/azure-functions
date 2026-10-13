/// <reference types="jest" />

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("../blob-storage", () => ({
  ...jest.requireActual("../blob-storage"),
  deletePublicBlob: jest.fn(),
  uploadPublicBlob: jest.fn(),
  vacanciesReadSasUrl: jest.fn(),
}));

type VacanciesModule = {
  allowedVacancyImageHosts: (
    env: { AzureWebJobsStorage?: string; VACANCY_IMAGE_ALLOWED_HOSTS?: string },
    warn?: (m: string) => void,
  ) => ReadonlySet<string>;
  isAllowedVacancyImageUrl: (url: string) => boolean;
};

const STORAGE = "DefaultEndpointsProtocol=https;AccountName=rpccprod;AccountKey=abc==;EndpointSuffix=core.windows.net";

describe("allowedVacancyImageHosts", () => {
  const { allowedVacancyImageHosts } = require("./vacancies") as VacanciesModule;

  it("defaults to the blob host of the storage account the app uses", () => {
    const warn = jest.fn();

    const hosts = allowedVacancyImageHosts({ AzureWebJobsStorage: STORAGE }, warn);

    expect([...hosts]).toEqual(["rpccprod.blob.core.windows.net"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("lets VACANCY_IMAGE_ALLOWED_HOSTS override the derived default, normalised", () => {
    const hosts = allowedVacancyImageHosts({
      AzureWebJobsStorage: STORAGE,
      VACANCY_IMAGE_ALLOWED_HOSTS: " CDN.Example.com , other.example.com ,, ",
    });

    expect([...hosts]).toEqual(["cdn.example.com", "other.example.com"]);
  });

  it("allows nothing, and says so, when neither source yields a host", () => {
    const warn = jest.fn();

    const hosts = allowedVacancyImageHosts({ AzureWebJobsStorage: "UseDevelopmentStorage=true" }, warn);

    expect(hosts.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/no image host is allowed/);
  });

  it("an explicit empty override also allows nothing, without a warning", () => {
    const warn = jest.fn();

    const hosts = allowedVacancyImageHosts({ AzureWebJobsStorage: STORAGE, VACANCY_IMAGE_ALLOWED_HOSTS: "" }, warn);

    expect(hosts.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("isAllowedVacancyImageUrl with the derived default", () => {
  const saved = { hosts: process.env.VACANCY_IMAGE_ALLOWED_HOSTS, storage: process.env.AzureWebJobsStorage };

  afterEach(() => {
    for (const [key, value] of [
      ["VACANCY_IMAGE_ALLOWED_HOSTS", saved.hosts],
      ["AzureWebJobsStorage", saved.storage],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // The allowlist is built when the module loads, so load a fresh copy per env.
  function load(env: { hosts?: string; storage?: string }): VacanciesModule {
    if (env.hosts === undefined) delete process.env.VACANCY_IMAGE_ALLOWED_HOSTS;
    else process.env.VACANCY_IMAGE_ALLOWED_HOSTS = env.hosts;
    if (env.storage === undefined) delete process.env.AzureWebJobsStorage;
    else process.env.AzureWebJobsStorage = env.storage;
    let mod!: VacanciesModule;
    jest.isolateModules(() => {
      mod = require("./vacancies") as VacanciesModule;
    });
    return mod;
  }

  it("accepts the real storage account's host and rejects the old hardcoded one", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { isAllowedVacancyImageUrl } = load({ storage: STORAGE });

    expect(isAllowedVacancyImageUrl("https://rpccprod.blob.core.windows.net/vacancies/a.jpg")).toBe(true);
    expect(isAllowedVacancyImageUrl("https://cmctest.blob.core.windows.net/vacancies/a.jpg")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses the override instead of the derived host when one is set", () => {
    const { isAllowedVacancyImageUrl } = load({ hosts: "cdn.example.com", storage: STORAGE });

    expect(isAllowedVacancyImageUrl("https://cdn.example.com/a.jpg")).toBe(true);
    expect(isAllowedVacancyImageUrl("https://rpccprod.blob.core.windows.net/a.jpg")).toBe(false);
  });

  it("rejects everything and logs exactly once when no host can be derived", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { isAllowedVacancyImageUrl } = load({});

    expect(isAllowedVacancyImageUrl("https://rpccprod.blob.core.windows.net/a.jpg")).toBe(false);
    expect(isAllowedVacancyImageUrl("https://cdn.example.com/a.jpg")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
