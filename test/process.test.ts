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

test("ordered display tail follows both pipes after prefix limits and stays bounded", async () => {
	const updates: string[] = [];
	const result = await runProcess({
		executable: process.execPath,
		args: ["-e", `process.stdout.write('OUT-START\\n' + 'x'.repeat(40000));
			setTimeout(() => process.stderr.write('\\nERR-MIDDLE\\n' + 'y'.repeat(40000)), 350);
			setTimeout(() => process.stdout.write('\\nOUT-LATE-😀\\n'), 700);
			setTimeout(() => process.stderr.write('ERR-LAST-한글\\n'), 1050);
			setTimeout(() => process.exit(0), 1350);`],
		timeoutMs: 3000,
		captureDisplay: true,
		onOutput: (update) => {
			updates.push(update.displayOutput ?? "");
			expect(Buffer.byteLength(update.displayOutput ?? "")).toBeLessThanOrEqual(32768);
		},
	});
	expect(result.stdout).toStartWith("OUT-START");
	expect(result.stdout).not.toContain("OUT-LATE");
	expect(result.stderr).not.toContain("ERR-LAST");
	expect(updates.some((text) => text.includes("y".repeat(100)))).toBe(true);
	expect(result.displayOutput).toContain("OUT-LATE-😀\nERR-LAST-한글\n");
	expect(result.displayOutput).not.toContain("OUT-START");
	expect(result.displayTruncated).toBe(true);
	expect(updates.some((text) => text.includes("OUT-LATE-😀"))).toBe(true);
	expect(updates.at(-1)).toContain("ERR-LAST-한글");
	expect(updates.length).toBeLessThanOrEqual(5);
});

test("display tail marks truncation only when bytes are discarded, including replacement", async () => {
	const exact = await runProcess({
		executable: process.execPath,
		args: ["-e", "process.stdout.write('a'.repeat(32768))"],
		timeoutMs: 3000,
		captureDisplay: true,
	});
	expect(exact.displayOutput).toBe("a".repeat(32768));
	expect(exact.displayTruncated).toBe(false);
	expect(exact.truncated).toBe(false);

	const over = await runProcess({
		executable: process.execPath,
		args: ["-e", "process.stdout.write('b'.repeat(32769))"],
		timeoutMs: 3000,
		captureDisplay: true,
	});
	expect(over.displayOutput).toBe("b".repeat(32768));
	expect(over.displayTruncated).toBe(true);

	const replaced = await runProcess({
		executable: process.execPath,
		args: ["-e", "process.stderr.write('old'); setTimeout(() => process.stdout.write('c'.repeat(32768)), 50)"],
		timeoutMs: 3000,
		captureDisplay: true,
	});
	expect(replaced.displayOutput).toBe("c".repeat(32768));
	expect(replaced.displayTruncated).toBe(true);

	const alreadyTruncated = await runProcess({
		executable: process.execPath,
		args: ["-e", "process.stderr.write('b'.repeat(32769)); setTimeout(() => process.stdout.write('d'.repeat(32768)), 50)"],
		timeoutMs: 3000,
		captureDisplay: true,
	});
	expect(alreadyTruncated.displayOutput).toBe("d".repeat(32768));
	expect(alreadyTruncated.displayTruncated).toBe(true);
});

test("split UTF-8 sequences and many lines retain complete tail text", async () => {
	const result = await runProcess({
		executable: process.execPath,
		args: ["-e", `const b = Buffer.from('😀'); process.stdout.write(b.subarray(0, 2));
			setTimeout(() => { process.stderr.write('ERR\\n'); process.stdout.write(b.subarray(2));
			process.stdout.write('\\n' + 'line\\n'.repeat(9000) + 'LAST'); }, 30);`],
		timeoutMs: 3000,
		captureDisplay: true,
	});
	expect(result.displayOutput).toEndWith("LAST");
	expect(result.displayOutput).not.toContain("�");
	expect(result.displayOutput!.split("\n").length).toBeLessThanOrEqual(1901);
	expect(result.displayTruncated).toBe(true);
	// Decoders never stitch incomplete bytes from different streams together.
	expect(result.stdout).toStartWith("😀");
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
		captureDisplay: true,
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
	expect(result.displayOutput).toContain("start");
	expect(Buffer.byteLength(result.displayOutput ?? "")).toBeLessThanOrEqual(32768);
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
	expect(auth.displayOutput).toBeUndefined();
	const other = await runProcess({
		executable: process.execPath,
		args: ["-e", script],
		timeoutMs: 5000,
	});
	expect(other.stdout).toBe("absent");
});
