import { describe, it, expect } from "vitest";
import { _testUtils } from "../gh-trace.js";

const { extractOperation, redactArgs, parseIncludedHttpResponse } = _testUtils;

describe("extractOperation", () => {
  it("returns 'gh' for empty args", () => {
    expect(extractOperation([])).toBe("gh");
  });

  it("returns 'gh.<cmd>' for single arg", () => {
    expect(extractOperation(["api"])).toBe("gh.api");
  });

  it("returns 'gh.api.graphql' for graphql endpoint", () => {
    expect(extractOperation(["api", "graphql", "-f", "query=..."])).toBe("gh.api.graphql");
  });

  it("skips leading flags to find first positional", () => {
    expect(extractOperation(["api", "--method", "GET", "repos/acme/repo/pulls"])).toBe("gh.api.repos");
  });

  it("extracts first path segment from REST URL", () => {
    expect(extractOperation(["api", "repos/acme/repo/pulls/123/comments?per_page=1"])).toBe("gh.api.repos");
  });

  it("handles -H flag pairs", () => {
    expect(extractOperation(["api", "-H", "Accept: application/json", "graphql"])).toBe("gh.api.graphql");
  });
});

describe("redactArgs", () => {
  it("passes through normal args unchanged", () => {
    expect(redactArgs(["api", "graphql", "-f", "query={...}"])).toEqual([
      "api", "graphql", "-f", "query={...}",
    ]);
  });

  it("redacts Authorization header value after -H", () => {
    const result = redactArgs(["api", "-H", "Authorization: bearer ghp_secret123"]);
    expect(result[2]).toBe("Authorization: [REDACTED]");
  });

  it("redacts Authorization header value after --header", () => {
    const result = redactArgs(["api", "--header", "Authorization: token abc"]);
    expect(result[2]).toBe("Authorization: [REDACTED]");
  });

  it("redacts token= field values", () => {
    const result = redactArgs(["-f", "token=ghp_secret"]);
    expect(result[1]).toBe("token=[REDACTED]");
  });

  it("redacts password= field values", () => {
    const result = redactArgs(["-F", "password=s3cret"]);
    expect(result[1]).toBe("password=[REDACTED]");
  });

  it("does not redact non-sensitive fields", () => {
    const result = redactArgs(["-f", "owner=acme"]);
    expect(result[1]).toBe("owner=acme");
  });
});

describe("parseIncludedHttpResponse", () => {
  it("returns empty headers for non-HTTP output", () => {
    const result = parseIncludedHttpResponse('{"data":{}}');
    expect(result.statusLine).toBeUndefined();
    expect(result.headers).toEqual({});
  });

  it("parses status line and headers", () => {
    const output = [
      "HTTP/2 200",
      "etag: W/\"abc123\"",
      "x-ratelimit-remaining: 4999",
      "",
      '{"data":{}}',
    ].join("\n");
    const result = parseIncludedHttpResponse(output);
    expect(result.statusLine).toBe("HTTP/2 200");
    expect(result.headers["etag"]).toBe("W/\"abc123\"");
    expect(result.headers["x-ratelimit-remaining"]).toBe("4999");
  });

  it("takes the last HTTP/ status line on redirects", () => {
    const output = [
      "HTTP/1.1 302 Found",
      "location: https://example.com",
      "",
      "HTTP/1.1 200 OK",
      "etag: W/\"final\"",
      "",
      '{"data":{}}',
    ].join("\n");
    const result = parseIncludedHttpResponse(output);
    expect(result.statusLine).toBe("HTTP/1.1 200 OK");
    expect(result.headers["etag"]).toBe("W/\"final\"");
  });
});
