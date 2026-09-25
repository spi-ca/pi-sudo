import { expect, test } from "bun:test";
import { boundedError, boundedText, formatOutcome } from "../src/output.js";
import type { Outcome } from "../src/process.js";

const base: Outcome = {
	code: 0,
	stdout: "",
	stderr: "",
	truncated: false,
	cancelled: false,
	timedOut: false,
};

test("final text bounds account for replacement bytes, multibyte characters, header and warnings", () => {
	for (const result of [
		{
			...base,
			stdout: Buffer.alloc(32768, 0xff).toString("utf8"),
			stderr: Buffer.alloc(32768, 0xff).toString("utf8"),
		},
		{
			...base,
			code: 9,
			stdout: "한".repeat(32768),
			stderr: "語".repeat(32768),
			cleanupWarning: "sudo -k cleanup failed",
		},
		{ ...base, stdout: "line\n".repeat(3000) },
	]) {
		const formatted = formatOutcome(result);
		expect(formatted.truncated).toBe(true);
		expect(formatted.text).toContain("truncated=true");
		expect(Buffer.byteLength(formatted.text)).toBeLessThanOrEqual(48 * 1024);
		expect(formatted.text.split("\n").length).toBeLessThanOrEqual(2000);
		if (result.cleanupWarning)
			expect(formatted.text).toContain(result.cleanupWarning);
	}
	const clean = formatOutcome({ ...base, stdout: "한글" });
	expect(clean.truncated).toBe(false);
	expect(clean.text).toContain("한글");
	expect(boundedText(["x".repeat(100000)]).truncated).toBe(true);
	const error = boundedError("line\n".repeat(3000) + "x".repeat(100000));
	expect(error).toEndWith("[truncated]");
	expect(error.split("\n").length).toBeLessThanOrEqual(2000);
	expect(Buffer.byteLength(error)).toBeLessThanOrEqual(48 * 1024);
});
