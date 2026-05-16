"use client";

interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
  timeoutMessage?: string;
}

interface InflightFetch {
  controller: AbortController;
  consumers: number;
  maxConsumers: number;
  promise: Promise<Response>;
  settled: boolean;
}

const inflightFetches = new Map<string, InflightFetch>();

function getFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function getFetchMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function hashBody(body: BodyInit | null | undefined): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return `blob:${body.type}:${body.size}`;
  if (body instanceof ArrayBuffer) return `array-buffer:${body.byteLength}`;
  if (ArrayBuffer.isView(body)) {
    return `${body.constructor.name}:${body.byteOffset}:${body.byteLength}`;
  }
  if (body instanceof FormData) {
    return [...body.entries()]
      .map(([key, value]) =>
        typeof File !== "undefined" && value instanceof File
          ? `${key}=file:${value.name}:${value.type}:${value.size}`
          : `${key}=${value}`,
      )
      .join("&");
  }
  return body.constructor.name;
}

function hashHeaders(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return [...headers.entries()]
    .map(([key, value]) => `${key.toLowerCase()}:${value}`)
    .sort()
    .join("\n");
}

function getFetchKey(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return `${getFetchUrl(input)}|${getFetchMethod(input, init)}|${hashHeaders(input, init)}|${hashBody(init?.body)}`;
}

function cloneResponse(response: Response): Response {
  if (typeof response.clone !== "function") {
    throw new TypeError("Cannot clone deduplicated fetch response");
  }
  return response.clone();
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

async function readResponseText(response: Response, signal: AbortSignal | undefined): Promise<string> {
  throwIfAborted(signal);

  if (!response.body) {
    return typeof response.text === "function" ? await response.text() : "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  try {
    while (true) {
      throwIfAborted(signal);
      let removeAbortListener: () => void = () => {};
      const abortPromise =
        signal === undefined
          ? null
          : new Promise<never>((_, reject) => {
              const abort = () => {
                void reader.cancel().catch(() => {});
                reject(abortError());
              };
              if (signal.aborted) {
                abort();
                return;
              }
              signal.addEventListener("abort", abort, { once: true });
              removeAbortListener = () => signal.removeEventListener("abort", abort);
            });

      try {
        const result = await Promise.race([
          reader.read(),
          ...(abortPromise ? [abortPromise] : []),
        ]);
        if (result.done) break;
        chunks.push(decoder.decode(result.value, { stream: true }));
      } finally {
        removeAbortListener();
      }
    }
  } finally {
    reader.releaseLock();
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

async function readResponseJson<T>(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  if (!response.body && typeof response.json === "function") {
    return (await response.json()) as T;
  }
  return JSON.parse(await readResponseText(response, signal)) as T;
}

export function dedupFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const key = getFetchKey(input, init);
  let entry = inflightFetches.get(key);
  if (!entry) {
    const controller = new AbortController();
    const { signal: _signal, ...sharedInit } = init ?? {};
    const request = fetch(input, { ...sharedInit, signal: controller.signal });
    const newEntry: InflightFetch = {
      controller,
      consumers: 0,
      maxConsumers: 0,
      promise: request,
      settled: false,
    };
    request.finally(() => {
      newEntry.settled = true;
      inflightFetches.delete(key);
    }).catch(() => {
      // The original request promise is returned to callers; this side-effect
      // chain only prevents an unhandled rejection from the cleanup branch.
    });
    entry = newEntry;
    inflightFetches.set(key, entry);
  }

  entry.consumers += 1;
  entry.maxConsumers = Math.max(entry.maxConsumers, entry.consumers);

  const callerSignal = init?.signal ?? undefined;
  let removeAbortListener: () => void = () => {};
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    removeAbortListener();
    entry.consumers -= 1;
    if (entry.consumers === 0 && !entry.settled) {
      entry.controller.abort();
    }
  };

  const responsePromise = entry.promise.then((response) =>
    entry.maxConsumers > 1 ? cloneResponse(response) : response,
  );

  const abortPromise =
    callerSignal === undefined
      ? null
      : new Promise<never>((_, reject) => {
          const abort = () => {
            release();
            reject(abortError());
          };
          if (callerSignal.aborted) {
            abort();
            return;
          }
          callerSignal.addEventListener("abort", abort, { once: true });
          removeAbortListener = () => callerSignal.removeEventListener("abort", abort);
        });

  return Promise.race([responsePromise, ...(abortPromise ? [abortPromise] : [])]).finally(
    release,
  );
}

export function __clearInflightFetchesForTest(): void {
  for (const entry of inflightFetches.values()) {
    entry.controller.abort();
  }
  inflightFetches.clear();
}

function mergeAbortSignals(
  signals: Array<AbortSignal | null | undefined>,
): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];

  const controller = new AbortController();
  const abort = () => controller.abort();

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }

  return controller.signal;
}

async function readErrorMessage(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<string> {
  try {
    const payload = await readResponseJson<{ error?: string; message?: string } | null>(
      response,
      signal,
    );
    const message = payload?.error ?? payload?.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw error;
    }
    // Ignore parse failures and fall back to status text.
  }

  const statusText = typeof response.statusText === "string" ? response.statusText.trim() : "";
  if (statusText.length > 0) {
    return `${response.status} ${statusText}`;
  }

  return `HTTP ${response.status}`;
}

export async function fetchJsonWithTimeout<T>(
  input: RequestInfo | URL,
  options: FetchJsonOptions = {},
): Promise<T> {
  const { timeoutMs = 8_000, timeoutMessage, signal, ...init } = options;
  const timeoutController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let removeAbortListener: () => void = () => {};
  let timedOut = false;

  try {
    const mergedSignal = mergeAbortSignals([signal, timeoutController.signal]);
    const requestInit: RequestInit = { ...init };
    if (mergedSignal) {
      requestInit.signal = mergedSignal;
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
        reject(new Error(timeoutMessage ?? `Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    void timeoutPromise.catch(() => {});

    const abortPromise =
      mergedSignal === undefined
        ? null
        : new Promise<never>((_, reject) => {
            const abort = () => {
              if (!timedOut) {
                reject(abortError());
              }
            };
            if (mergedSignal.aborted) {
              abort();
              return;
            }
            mergedSignal.addEventListener("abort", abort, { once: true });
            removeAbortListener = () => mergedSignal.removeEventListener("abort", abort);
          });
    void abortPromise?.catch(() => {});

    const response = await Promise.race([
      dedupFetch(input, requestInit).catch((error: unknown) => {
        if (timedOut) {
          throw new Error(timeoutMessage ?? `Request timed out after ${timeoutMs}ms`, {
            cause: error,
          });
        }
        throw error;
      }),
      timeoutPromise,
      ...(abortPromise ? [abortPromise] : []),
    ]);

    const readWithTimeout = <T>(read: Promise<T>): Promise<T> =>
      Promise.race([
        read.catch((error: unknown) => {
          if (timedOut) {
            throw new Error(timeoutMessage ?? `Request timed out after ${timeoutMs}ms`, {
              cause: error,
            });
          }
          throw error;
        }),
        timeoutPromise,
        ...(abortPromise ? [abortPromise] : []),
      ]);

    if (!response.ok) {
      throw new Error(await readWithTimeout(readErrorMessage(response, mergedSignal)));
    }

    return await readWithTimeout(readResponseJson<T>(response, mergedSignal));
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    removeAbortListener();
  }
}
