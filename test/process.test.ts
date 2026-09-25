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

test("streams coalesced bounded snapshots before exit and stops updating after completion", async () => {
	const updates: { stdout: string; stderr: string; truncated: boolean }[] = [];
	let settled = false;
	const result = await runProcess({
		executable: process.execPath,
		args: ["-e", `process.stdout.write('first'); process.stderr.write('err');
			setTimeout(() => { process.stdout.write('second'); process.stderr.write('x'.repeat(100000)); }, 650);
			setTimeout(() => process.exit(0), 1300);`],
		timeoutMs: 3000,
		onOutput: (update) => {
			expect(settled).toBe(false);
			updates.push(update);
		},
	}).then((value) => { settled = true; return value; });
	expect(updates.length).toBeGreaterThanOrEqual(2);
	expect(updates[0]).toMatchObject({ stdout: "first", stderr: "err", truncated: false });
	expect(updates.at(-1)).toMatchObject({ stdout: "firstsecond", truncated: true });
	expect(updates.at(-1)?.stderr.length).toBe(32768);
	expect(updates.length).toBeLessThanOrEqual(3);
	expect(result.stdout).toBe("firstsecond");
	expect(result.truncated).toBe(true);
	const count = updates.length;
	await Bun.sleep(200);
	expect(updates).toHaveLength(count);
});

test("pending updates are cleared on close, spawn error, abort and timeout", async () => {
	let updates = 0;
	const onOutput = () => { updates++; };
	await runProcess({ executable: process.execPath, args: ["-e", "process.stdout.write('quick')"], timeoutMs: 1000, onOutput });
	const controller = new AbortController();
	let ready!: () => void;
	const first = new Promise<void>((resolve) => { ready = resolve; });
	const running = runProcess({ executable: process.execPath, args: ["-e", "process.stdout.write('abort'); setInterval(() => {}, 1000)"], timeoutMs: 3000, signal: controller.signal, onOutput: () => { onOutput(); ready(); } });
	await first;
	controller.abort();
	await running;
	await runProcess({ executable: process.execPath, args: ["-e", "process.stdout.write('timeout'); setInterval(() => {}, 1000)"], timeoutMs: 40, onOutput });
	await expect(runProcess({ executable: "/no/such/executable/pi-sudo-test", args: [], timeoutMs: 1000, onOutput })).rejects.toThrow();
	const count = updates;
	await Bun.sleep(200);
	expect(updates).toBe(count);
});

test("abort suppresses partial updates while a SIGTERM-resistant child is still running", async () => {
	const controller = new AbortController();
	let firstUpdate!: () => void;
	const first = new Promise<void>((resolve) => { firstUpdate = resolve; });
	let updates = 0;
	let updatesAfterAbort = 0;
	let settled = false;
	const running = runProcess({
		executable: process.execPath,
		args: ["-e", `process.on('SIGTERM', () => {});
			process.stdout.write('start');
			setInterval(() => process.stdout.write('more'), 30);`],
		timeoutMs: 3000,
		signal: controller.signal,
		onOutput: () => {
			updates++;
			if (controller.signal.aborted) updatesAfterAbort++;
			firstUpdate();
		},
	}).then((result) => { settled = true; return result; });
	await first; // First update proves the handler and interval are running.
	controller.abort();
	const pendingDuringAbort = !settled;
	const result = await running;
	expect(updates).toBeGreaterThanOrEqual(1);
	expect(pendingDuringAbort).toBe(true);
	expect(updatesAfterAbort).toBe(0);
	expect(result.cancelled).toBe(true);
	expect(result.stdout).toContain("start");
});

test("timeout suppresses partial updates before a SIGTERM-resistant child settles", async () => {
	let updates = 0;
	let ready!: () => void;
	const first = new Promise<void>((resolve) => { ready = resolve; });
	const running = runProcess({
		executable: process.execPath,
		args: ["-e", `process.on('SIGTERM', () => {});
			process.stdout.write('start');
			setInterval(() => process.stdout.write('more'), 30);`],
		timeoutMs: 1500,
		onOutput: () => { updates++; ready(); },
	});
	await first; // Wait for a live child rather than assuming a startup deadline.
	const result = await running;
	expect(updates).toBeGreaterThanOrEqual(1);
	expect(result.timedOut).toBe(true);
	expect(result.stdout).toContain("start");
	const count = updates;
	await Bun.sleep(200);
	expect(updates).toBe(count);
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

test("askpass environment and auth streams are confined to the auth child", async () => {
	const script =
		"process.stdout.write(process.env.SUDO_ASKPASS || 'absent'); process.stderr.write('PRIVATE-CANARY')";
	const auth = await runProcess({
		executable: process.execPath,
		args: ["-e", script],
		askpass: "/trusted/helper",
		timeoutMs: 5000,
	});
	expect(auth.stdout).toBe("");
	expect(auth.stderr).toBe("");
	const other = await runProcess({
		executable: process.execPath,
		args: ["-e", script],
		timeoutMs: 5000,
	});
	expect(other.stdout).toBe("absent");
});
