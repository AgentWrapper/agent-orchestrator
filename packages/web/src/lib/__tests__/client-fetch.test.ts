import { afterEach, describe, expect, it, vi } from "vitest";
import { __clearInflightFetchesForTest, dedupFetch, fetchJsonWithTimeout } from "../client-fetch";

describe("dedupFetch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __clearInflightFetchesForTest();
  });

  it("shares one underlying request for concurrent requests with the same key", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = dedupFetch("/api/sessions/ao-187");
    const second = dedupFetch("/api/sessions/ao-187");

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    resolveFetch?.(response);

    await expect(first.then((res) => res.json())).resolves.toEqual({ ok: true });
    await expect(second.then((res) => res.json())).resolves.toEqual({ ok: true });
  });

  it("starts a new request after the in-flight request settles", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await dedupFetch("/api/sessions/ao-187");
    await dedupFetch("/api/sessions/ao-187");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce requests with different headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      dedupFetch("/api/sessions/ao-187", { headers: { Accept: "application/json" } }),
      dedupFetch("/api/sessions/ao-187", { headers: { Accept: "text/plain" } }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts the underlying fetch when all waiters abort", async () => {
    const controller = new AbortController();
    let underlyingSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          underlyingSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = dedupFetch("/api/sessions/ao-187", { signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(underlyingSignal?.aborted).toBe(true);
  });

  it("times out when response headers arrive but the JSON body stalls", async () => {
    vi.useFakeTimers();
    const cancelBody = vi.fn();
    const body = new ReadableStream({
      cancel: cancelBody,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchJsonWithTimeout("/api/sessions/ao-187", {
      timeoutMs: 100,
      timeoutMessage: "session timed out",
    });
    const expectation = expect(request).rejects.toThrow("session timed out");

    await vi.advanceTimersByTimeAsync(100);

    await expectation;
    expect(cancelBody).toHaveBeenCalled();
  });
});
