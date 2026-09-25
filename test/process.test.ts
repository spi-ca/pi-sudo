import { test, expect } from "bun:test";
import { runProcess } from "../src/process.js";

test("captures bounded output; never uses a shell", async () => {
	const result = await runProcess({
		executable: process.execPath,
		args: [
			"-e",
			"process.stdout.write('a'.repeat(200000));process.stderr.write('b'.repeat(200000))",
		],
		timeoutMs: 5000,
	});
	expect(result.code).toBe(0);
	expect(result.truncated).toBe(true);
	expect(Buffer.byteLength(result.stdout)).toBe(32768);
	expect(Buffer.byteLength(result.stderr)).toBe(32768);
});

test("spawn error settles; cancellation and timeout terminate direct process", async () => {
	await expect(
		runProcess({
			executable: "/no/such/executable/pi-sudo-test",
			args: [],
			timeoutMs: 1000,
		}),
	).rejects.toThrow();
	const controller = new AbortController();
	const running = runProcess({
		executable: process.execPath,
		args: ["-e", "setInterval(() => {}, 1000)"],
		timeoutMs: 5000,
		signal: controller.signal,
	});
	controller.abort();
	expect((await running).cancelled).toBe(true);
	const timed = await runProcess({
		executable: process.execPath,
		args: ["-e", "setInterval(() => {}, 1000)"],
		timeoutMs: 80,
	});
	expect(timed.timedOut).toBe(true);
});

test("deadline settles when the child exited but its descendant still holds output pipes", async () => {
	const started = performance.now();
	const result = await runProcess({
		executable: process.execPath,
		args: [
			"-e",
			`const {spawn} = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], {stdio:['ignore',1,2]}); process.exit(0);`,
		],
		timeoutMs: 200,
	});
	expect(result.timedOut).toBe(true);
	expect(performance.now() - started).toBeLessThan(1000);
});

test("pre-aborted invocation never starts a process", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		runProcess({
			executable: "/nonexistent",
			args: [],
			timeoutMs: 1000,
			signal: controller.signal,
		}),
	).rejects.toThrow("cancelled");
});
