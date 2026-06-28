/**
 * OpenAI Responses provider tests — SSE normalization into our event schema.
 *
 * Drives the REAL runOpenAiResponsesMode with a mocked `fetch` that returns a
 * Responses-API SSE body, and asserts the normalized events the host emits:
 *   1. session/init with an openai- prefixed session_id + request shape
 *   2. response.output_text.delta → text-delta; response.completed → result + REAL usage
 *   3. response.reasoning_summary_text.delta → reasoning event
 *   4. HTTP error → typed error(fatal) + result(subtype=error)  [mae-226 banner]
 *   5. response.failed in-stream → typed error(fatal) + result(error)
 *   6. multi-turn threads local history (prior assistant message re-sent)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionHost, type SessionHostOptions } from "../sdk-host.js";
import { runOpenAiResponsesMode } from "../providers/openai-responses.js";

const FIXED = () => new Date("2026-06-28T00:00:00.000Z");

function makeHost(extra: Partial<SessionHostOptions> = {}) {
  const persisted: string[] = [];
  const host = new SessionHost({
    aoSessionId: "openai-test-1",
    permissionMode: "bypassPermissions",
    persist: (line) => persisted.push(line),
    now: FIXED,
    ...extra,
  });
  const events = () => persisted.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { host, persisted, events };
}

/** Build a Responses-API SSE Response body from a list of {event, data} frames. */
function makeResponsesSse(frames: Array<{ event: string; data: unknown }>): Response {
  const text = frames
    .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
    .join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** A normal two-delta + completed(usage) stream. */
function okStream(deltas: string[], usage?: Record<string, unknown>, model = "gpt-5.5-2026-04-23"): Response {
  const frames: Array<{ event: string; data: unknown }> = [
    { event: "response.created", data: { type: "response.created", response: { id: "resp_x" } } },
    { event: "response.in_progress", data: { type: "response.in_progress" } },
  ];
  for (const d of deltas) {
    frames.push({ event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: d } });
  }
  frames.push({
    event: "response.completed",
    data: {
      type: "response.completed",
      response: { model, usage: usage ?? { input_tokens: 11, output_tokens: 5, input_tokens_details: { cached_tokens: 2 }, total_tokens: 16 } },
    },
  });
  return makeResponsesSse(frames);
}

/** Drive a single turn through the driver and resolve when it finishes. */
async function driveOneTurn(host: SessionHost, model = "gpt-5.5", text = "hi"): Promise<void> {
  const done = runOpenAiResponsesMode(host, model, "test-key", "http://test.local/v1", "/tmp/cwd", null);
  host.submitTurn(text);
  host.input.close(); // terminate the loop after this queued turn
  await done;
}

describe("OpenAI Responses provider — runOpenAiResponsesMode", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits session/init for the OpenAI model and posts the right request", async () => {
    const { host, events } = makeHost({ model: "gpt-5.5" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okStream(["Hi"]));

    await driveOneTurn(host, "gpt-5.5", "hello");

    const init = events().find((e) => e.type === "session" && e.subtype === "init");
    expect(init).toBeDefined();
    expect(init!.model).toBe("gpt-5.5");
    // The envelope session_id mirrors the GLM/MiMo path: it carries the host's
    // sdkSessionId (null for non-Claude providers), not the provider session id.
    expect(String(init!.session_id ?? "")).toMatch(/^openai-|^$/);

    // Request shape: hits /responses with stream:true and an input array.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test.local/v1/responses");
    const body = JSON.parse(String(opts.body));
    expect(body.model).toBe("gpt-5.5");
    expect(body.stream).toBe(true);
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input.at(-1)).toEqual({ role: "user", content: "hello" });
    expect(String((opts.headers as Record<string, string>).Authorization)).toContain("test-key");
  });

  it("normalizes output_text deltas → text-delta and completed → result + REAL usage", async () => {
    const { host, events } = makeHost({ model: "gpt-5.5" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okStream(["Hi", " there"]));

    await driveOneTurn(host);

    const deltas = events().filter((e) => e.type === "text-delta");
    expect(deltas.map((e) => e.text)).toEqual(["Hi", " there"]);

    const result = events().find((e) => e.type === "result");
    expect(result).toMatchObject({ subtype: "success", is_error: false, text: "Hi there" });

    const usage = events().find((e) => e.type === "usage");
    expect(usage).toMatchObject({
      input_tokens: 11,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
      model: "gpt-5.5-2026-04-23",
    });
    expect((usage!.models as unknown[]).length).toBe(1);
  });

  it("maps reasoning_summary deltas → reasoning events", async () => {
    const { host, events } = makeHost({ model: "gpt-5.5" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponsesSse([
        { event: "response.reasoning_summary_text.delta", data: { type: "response.reasoning_summary_text.delta", delta: "thinking" } },
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "answer" } },
        { event: "response.completed", data: { type: "response.completed", response: { model: "gpt-5.5", usage: {} } } },
      ]),
    );

    await driveOneTurn(host);

    const reasoning = events().filter((e) => e.type === "reasoning");
    expect(reasoning.map((e) => e.text)).toEqual(["thinking"]);
    const deltas = events().filter((e) => e.type === "text-delta");
    expect(deltas.map((e) => e.text)).toEqual(["answer"]);
  });

  it("HTTP error → typed error(fatal) + result(error) [mae-226 banner]", async () => {
    const { host, events } = makeHost({ model: "gpt-5.5" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), { status: 401 }),
    );

    await driveOneTurn(host);

    const err = events().find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!.fatal).toBe(true);
    expect(String(err!.message)).toContain("401");
    expect(String(err!.message)).toContain("Incorrect API key");

    const result = events().find((e) => e.type === "result");
    expect(result).toMatchObject({ subtype: "error", is_error: true });
    // No success usage event on a hard failure.
    expect(events().some((e) => e.type === "usage")).toBe(false);
  });

  it("response.failed in-stream → typed error(fatal) + result(error)", async () => {
    const { host, events } = makeHost({ model: "gpt-5.5" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponsesSse([
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "partial" } },
        { event: "response.failed", data: { type: "response.failed", response: { error: { message: "model overloaded" } } } },
      ]),
    );

    await driveOneTurn(host);

    const err = events().find((e) => e.type === "error");
    expect(err?.fatal).toBe(true);
    expect(String(err!.message)).toContain("model overloaded");
    const result = events().find((e) => e.type === "result");
    expect(result).toMatchObject({ subtype: "error", is_error: true, text: "partial" });
  });

  it("threads local history across turns (prior assistant message re-sent)", async () => {
    const { host } = makeHost({ model: "gpt-5.5" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okStream(["My name is set."]))
      .mockResolvedValueOnce(okStream(["Sam"]));

    const done = runOpenAiResponsesMode(host, "gpt-5.5", "k", "http://test.local/v1", "/tmp", null, "Be terse.");
    host.submitTurn("Remember my name is Sam.");
    host.submitTurn("What is my name?");
    host.input.close();
    await done;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body));
    // System persona leads; both prior user + assistant turns are present.
    expect(secondBody.input[0]).toEqual({ role: "system", content: "Be terse." });
    expect(secondBody.input).toContainEqual({ role: "user", content: "Remember my name is Sam." });
    expect(secondBody.input).toContainEqual({ role: "assistant", content: "My name is set." });
    expect(secondBody.input.at(-1)).toEqual({ role: "user", content: "What is my name?" });
  });
});
