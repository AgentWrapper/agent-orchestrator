import { describe, expect, it, vi } from "vitest";
import { createUrlWatcher } from "./detect-urls";

describe("createUrlWatcher", () => {
	it("reports an http(s) URL printed on a line", () => {
		const onUrl = vi.fn();
		const watcher = createUrlWatcher(onUrl);
		watcher.push("fake-agent: pushed PR https://github.com/org/repo/pull/42\n");
		expect(onUrl).toHaveBeenCalledExactlyOnceWith("https://github.com/org/repo/pull/42");
	});

	it("reports each distinct URL once, ignoring repeats", () => {
		const onUrl = vi.fn();
		const watcher = createUrlWatcher(onUrl);
		watcher.push("visit https://a.com/x and https://a.com/x again\n");
		watcher.push("still https://a.com/x\n");
		watcher.push("now https://b.com/y\n");
		expect(onUrl.mock.calls.map((c) => c[0])).toEqual(["https://a.com/x", "https://b.com/y"]);
	});

	it("strips ANSI colors and trailing punctuation", () => {
		const onUrl = vi.fn();
		const watcher = createUrlWatcher(onUrl);
		watcher.push("[32mopen (https://example.com/path).[0m\n");
		expect(onUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/path");
	});

	it("joins a URL split across two chunks and reports it once", () => {
		const onUrl = vi.fn();
		const watcher = createUrlWatcher(onUrl);
		watcher.push("see https://example.com/very/long/pa");
		expect(onUrl).not.toHaveBeenCalled(); // truncated at buffer edge, deferred
		watcher.push("th/here\n");
		expect(onUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/very/long/path/here");
	});

	it("ignores non-web schemes", () => {
		const onUrl = vi.fn();
		const watcher = createUrlWatcher(onUrl);
		watcher.push("mail me at mailto:dev@example.com or ftp://host/file\n");
		expect(onUrl).not.toHaveBeenCalled();
	});

	it("forgets state on reset", () => {
		const onUrl = vi.fn();
		const watcher = createUrlWatcher(onUrl);
		watcher.push("https://a.com/x\n");
		watcher.reset();
		watcher.push("https://a.com/x\n");
		expect(onUrl).toHaveBeenCalledTimes(2);
	});
});
