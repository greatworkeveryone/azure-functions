import { blobHostFromConnectionString } from "../blob-storage";

// base64 account keys end in "=" padding, which must not truncate the value.
const KEY = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4AAAA==";

describe("blobHostFromConnectionString", () => {
  it("derives {AccountName}.blob.{EndpointSuffix}", () => {
    expect(
      blobHostFromConnectionString(
        `DefaultEndpointsProtocol=https;AccountName=rpccprod;AccountKey=${KEY};EndpointSuffix=core.windows.net`,
      ),
    ).toBe("rpccprod.blob.core.windows.net");
  });

  it("prefers BlobEndpoint over the account name", () => {
    expect(
      blobHostFromConnectionString(
        `DefaultEndpointsProtocol=https;AccountName=rpccprod;AccountKey=${KEY};EndpointSuffix=core.windows.net;BlobEndpoint=https://files.example.com/`,
      ),
    ).toBe("files.example.com");
  });

  it("returns the hostname only, without port or path", () => {
    expect(
      blobHostFromConnectionString(`AccountName=devstoreaccount1;AccountKey=${KEY};BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;`),
    ).toBe("127.0.0.1");
  });

  it("supports a SAS connection string, which carries only BlobEndpoint", () => {
    expect(
      blobHostFromConnectionString("BlobEndpoint=https://rpccprod.blob.core.windows.net/;SharedAccessSignature=sv=2022&sig=abc%3D"),
    ).toBe("rpccprod.blob.core.windows.net");
  });

  it("lowercases the host and matches keys case-insensitively", () => {
    expect(blobHostFromConnectionString("accountname=RpccProd;ENDPOINTSUFFIX=Core.Windows.Net;")).toBe(
      "rpccprod.blob.core.windows.net",
    );
  });

  it("handles national-cloud suffixes", () => {
    expect(blobHostFromConnectionString("AccountName=acct;EndpointSuffix=core.chinacloudapi.cn")).toBe(
      "acct.blob.core.chinacloudapi.cn",
    );
  });

  it("falls back to the account name when BlobEndpoint is malformed", () => {
    expect(blobHostFromConnectionString("BlobEndpoint=not a url;AccountName=acct;EndpointSuffix=core.windows.net")).toBe(
      "acct.blob.core.windows.net",
    );
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["development storage", "UseDevelopmentStorage=true"],
    ["account name without a suffix", "AccountName=acct;AccountKey=abc"],
    ["suffix without an account name", "EndpointSuffix=core.windows.net"],
    ["garbage", "not a connection string"],
  ])("returns null for %s", (_label, input) => {
    expect(blobHostFromConnectionString(input)).toBeNull();
  });
});
