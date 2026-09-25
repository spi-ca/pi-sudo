import { describe, expect, test } from "bun:test";
import type { Invocation, Outcome, Runner } from "../src/process.js";
import {
	SudoAccess,
	validMinutes,
	validateExec,
	type Clock,
} from "../src/sudo.js";

const ok: Outcome = {
	code: 0,
	stdout: "",
	stderr: "",
	truncated: false,
	cancelled: false,
	timedOut: false,
};
const fail: Outcome = { ...ok, code: 1 };
function fixture(responses: Array<Outcome | Error> = []) {
	const calls: Invocation[] = [];
	let now = 0;
	const timers = new Map<number, { due: number; callback: () => void }>();
	let next = 1;
	const clock: Clock = {
		now: () => now,
		setTimeout: (fn, ms) => {
			const key = next++;
			timers.set(key, { due: now + ms, callback: fn });
			return key as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: (id) => {
			timers.delete(id as unknown as number);
		},
	};
	const runner: Runner = async (invocation) => {
		calls.push(invocation);
		const response = responses.shift() ?? ok;
		if (response instanceof Error) throw response;
		return response;
	};
	const access = new SudoAccess(runner, "/usr/bin/sudo", clock);
	return {
		access,
		calls,
		advance: (ms: number) => {
			now += ms;
			for (const [key, timer] of timers)
				if (timer.due <= now) {
					timers.delete(key);
					timer.callback();
				}
		},
		timers,
	};
}

async function tick() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("sudo authorization state", () => {
	test("explicit -k, interactive -v, noninteractive execution probe, then -n exec, lock", async () => {
		const f = fixture();
		await f.access.unlock(5, true);
		expect(f.calls.map((call) => call.args)).toEqual([
			["-k"],
			["-v"],
			["-n", "--", "/usr/bin/true"],
		]);
		expect(f.calls[1].interactive).toBe(true);
		expect(f.calls[2].interactive).toBeUndefined();
		await f.access.exec("/usr/bin/id", ["-u"], "/tmp");
		expect(f.calls[3]).toMatchObject({
			executable: "/usr/bin/sudo",
			args: ["-n", "--", "/usr/bin/id", "-u"],
			cwd: "/tmp",
		});
		await f.access.lock();
		expect(f.calls.at(-1)?.args).toEqual(["-k"]);
		expect(f.access.remainingMs()).toBe(0);
		await expect(f.access.exec("/usr/bin/id", [])).rejects.toThrow("locked");
	});
	test("no TUI, invalid duration, repeated unlock and invalid paths fail closed", async () => {
		const f = fixture();
		await expect(f.access.unlock(5, false)).rejects.toThrow("interactive");
		await expect(f.access.unlock(16, true)).rejects.toThrow("Duration");
		expect(f.calls).toHaveLength(0);
		await f.access.unlock(5, true);
		await expect(f.access.unlock(5, true)).rejects.toThrow("Already unlocked");
		await expect(f.access.exec("sh", [])).rejects.toThrow("absolute");
		expect(() => validateExec("/bin/sh", ["x\0y"])).toThrow("NUL");
		expect(() => validateExec("/bin/sh", [], "relative")).toThrow("absolute");
		expect(validMinutes("15")).toBe(15);
		expect(() => validMinutes("1.5")).toThrow();
		expect(() => validMinutes("0")).toThrow();
	});
	test("failed auth, failed probe, and spawn error invalidate and never unlock", async () => {
		for (const responses of [
			[ok, fail],
			[ok, ok, fail],
			[ok, new Error("spawn error")],
		]) {
			const f = fixture(responses);
			await expect(f.access.unlock(5, true)).rejects.toThrow();
			expect(f.calls.at(-1)?.args).toEqual(["-k"]);
			expect(f.access.remainingMs()).toBe(0);
		}
	});
	test("deadline fires lock, no renewal; nonzero execution revokes", async () => {
		const f = fixture([ok, ok, ok, fail]);
		await f.access.unlock(1, true);
		f.advance(30_000);
		expect(f.access.remainingMs()).toBe(30_000);
		expect((await f.access.exec("/usr/bin/id", [])).code).toBe(1);
		expect(f.access.remainingMs()).toBe(0);
		await f.access.unlock(1, true);
		f.advance(60_001);
		await tick();
		expect(f.access.remainingMs()).toBe(0);
		expect(f.calls.at(-1)?.args).toEqual(["-k"]);
	});
	test("concurrent exec rejected; lock cancels running child and blocks new unlock", async () => {
		let release!: (result: Outcome) => void;
		const runnerCalls: Invocation[] = [];
		const run: Runner = (invocation) => {
			runnerCalls.push(invocation);
			if (invocation.args[0] === "-n" && invocation.args[2] === "/usr/bin/id") {
				return new Promise((resolve) => {
					release = resolve;
				});
			}
			return Promise.resolve(ok);
		};
		const access = new SudoAccess(run, "/usr/bin/sudo");
		await access.unlock(5, true);
		const running = access.exec("/usr/bin/id", []);
		await expect(access.exec("/usr/bin/id", [])).rejects.toThrow("busy");
		const locking = access.lock();
		expect(runnerCalls.at(-1)?.signal?.aborted).toBe(true);
		await expect(access.unlock(5, true)).rejects.toThrow("busy");
		release({ ...ok, cancelled: true });
		await running;
		await locking;
		expect(access.remainingMs()).toBe(0);
		expect(runnerCalls.at(-1)?.args).toEqual(["-k"]);
	});
	test("lock during auth cannot grant state even after late successful response", async () => {
		let release!: (result: Outcome) => void;
		const calls: Invocation[] = [];
		const run: Runner = (invocation) => {
			calls.push(invocation);
			if (invocation.args[0] === "-v")
				return new Promise((resolve) => {
					release = resolve;
				});
			return Promise.resolve(ok);
		};
		const access = new SudoAccess(run, "/usr/bin/sudo");
		const pending = access.unlock(5, true);
		await tick();
		const lock = access.lock();
		expect(calls[1].signal?.aborted).toBe(true);
		release(ok);
		await expect(pending).rejects.toThrow();
		await lock;
		expect(access.remainingMs()).toBe(0);
	});
	test("abort signal, timeout result and failed -k fail closed", async () => {
		const f = fixture([ok, ok, ok, { ...ok, timedOut: true }, ok]);
		await f.access.unlock(5, true);
		const result = await f.access.exec("/usr/bin/id", []);
		expect(result.timedOut).toBe(true);
		expect(f.access.remainingMs()).toBe(0);
		const g = fixture([fail]);
		await expect(g.access.unlock(5, true)).rejects.toThrow();
		expect(g.access.remainingMs()).toBe(0);
		const h = fixture();
		await h.access.unlock(5, true);
		const abort = new AbortController();
		abort.abort();
		await expect(
			h.access.exec("/usr/bin/id", [], undefined, abort.signal),
		).rejects.toThrow("cancelled");
		expect(h.calls.some((call) => call.args[2] === "/usr/bin/id")).toBe(false);
		expect(h.access.remainingMs()).toBe(0);
	});
});

test("unconfirmed process termination poisons future unlocks", async () => {
	const f = fixture([ok, ok, ok, { ...ok, terminationUnconfirmed: true }, ok]);
	await f.access.unlock(1, true);
	await expect(f.access.exec("/usr/bin/id", [])).rejects.toThrow(
		"termination could not be confirmed",
	);
	expect(f.access.remainingMs()).toBe(0);
	await expect(f.access.unlock(1, true)).rejects.toThrow("restart Pi");
});

test("wall-clock suspend expires grant, clock rollback cannot extend monotonic deadline", async () => {
	for (const suspend of [true, false]) {
		let mono = 0;
		let wall = 0;
		const time: Clock = {
			now: () => mono,
			wallNow: () => wall,
			setTimeout,
			clearTimeout,
		};
		const calls: Invocation[] = [];
		const access = new SudoAccess(
			async (invocation) => {
				calls.push(invocation);
				return ok;
			},
			"/usr/bin/sudo",
			time,
		);
		await access.unlock(1, true);
		if (suspend) wall = 120_000;
		else {
			mono = 60_001;
			wall = -120_000;
		}
		await expect(access.exec("/usr/bin/id", [])).rejects.toThrow("locked");
		await access.lock();
		expect(calls.some((call) => call.args[2] === "/usr/bin/id")).toBe(false);
	}
});
