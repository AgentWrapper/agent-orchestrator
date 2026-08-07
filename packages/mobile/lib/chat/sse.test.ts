import { describe, expect, it } from "vitest";
import { parseSseFrame, takeSseFrames } from "./sse";

describe("mobile conversation SSE", () => {
	it("keeps an incomplete tail while reading multiple LF frames", () => {
		const result = takeSseFrames("id: 1\ndata: {\"seq\":1}\n\nid: 2\ndata: {\"seq\":2}\n\nid: 3\nda");
		expect(result.frames).toHaveLength(2);
		expect(result.remainder).toBe("id: 3\nda");
	});

	it("accepts CRLF boundaries from proxies", () => {
		const result = takeSseFrames("id: 4\r\ndata: {\"seq\":4}\r\n\r\n");
		expect(result.frames).toEqual(["id: 4\r\ndata: {\"seq\":4}"]);
		expect(parseSseFrame(result.frames[0])?.seq).toBe(4);
	});

	it("uses the SSE id when old daemons omit seq and ignores malformed data", () => {
		expect(parseSseFrame('id: 9\ndata: {"projectId":"p","type":"session_updated"}')?.seq).toBe(9);
		expect(parseSseFrame("id: 10\ndata: nope")).toBeUndefined();
	});
});
