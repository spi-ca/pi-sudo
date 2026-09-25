import { test, expect } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.js";
import type { Invocation, Outcome, Runner } from "../src/process.js";

const ok: Outcome = {
	code: 0,
	stdout: "",
	stderr: "",
	cancelled: false,
	timedOut: false,
	truncated: false,
};
function fixture(
	options: {
		mode?: string;
		tty?: boolean;
		confirm?: () => Promise<boolean>;
		run?: Runner;
		restoreFails?: boolean;
		host?: () => void;
		askpass?: () => string | undefined;
		resolveAskpass?: (value: string | undefined) => string;
	} = {},
) {
	const calls: Invocation[] = [];
	const events: string[] = [];
	const messages: string[] = [];
	let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	let shutdown!: (
		event: { type: "session_shutdown" },
		ctx: ExtensionContext,
	) => Promise<void>;
	let tool!: { execute: (...args: any[]) => Promise<unknown> };
	const pi = {
		registerCommand: (_name: string, options: { handler: typeof command }) => {
			command = options.handler;
		},
		registerTool: (value: typeof tool) => {
			tool = value;
		},
		on: (name: string, handler: typeof shutdown) => {
			if (name === "session_shutdown") shutdown = handler;
			return () => {};
		},
	} as unknown as ExtensionAPI;
	extension(
		pi,
		async (invocation) => {
			calls.push(invocation);
			if (invocation.args[0] === "-v") expect(events.at(-1)).toBe("stop");
			return options.run ? options.run(invocation) : ok;
		},
		() => options.tty ?? true,
		options.host ?? (() => {}),
		options.askpass ?? (() => undefined),
		options.resolveAskpass ?? (() => "/trusted/helper"),
	);
	const ctx = {
		mode: options.mode ?? "tui",
		cwd: "/tmp",
		waitForIdle: async () => {
			events.push("idle");
		},
		ui: {
			confirm: async (_title: string, warning: string) => {
				expect(warning).toContain("ANY command");
				if (warning.includes("OS askpass"))
					expect(warning).toContain("/trusted/helper");
				events.push("confirm");
				return options.confirm ? options.confirm() : true;
			},
			notify: (message: string) => {
				messages.push(message);
			},
			setStatus: () => {},
			custom: async (factory: (...args: any[]) => unknown) => {
				let resolve!: (value: unknown) => void;
				const result = new Promise<unknown>((done) => {
					resolve = done;
				});
				factory(
					{
						stop: () => events.push("stop"),
						start: () => {
							events.push("start");
							if (options.restoreFails) throw new Error("restore failure");
						},
						requestRender: () => {},
					},
					{},
					{},
					resolve,
				);
				return result;
			},
		},
	} as unknown as ExtensionCommandContext;
	return {
		calls,
		events,
		messages,
		command: (args: string) => command(args, ctx),
		exec: (signal?: AbortSignal) =>
			tool.execute(
				"id",
				{ executable: "/usr/bin/id", args: [] },
				signal,
				undefined,
				ctx,
			),
		shutdown: () => shutdown({ type: "session_shutdown" }, ctx),
	};
}

test("non-TUI and non-TTY unlock fail before any sudo; locked tools fail", async () => {
	for (const options of [{ mode: "print" }, { mode: "rpc" }, { tty: false }]) {
		const f = fixture(options);
		await f.command("unlock 1");
		expect(f.messages.at(-1)).toContain("TUI");
		await f.command("status");
		expect(f.messages.at(-1)).toBe("sudo locked");
		await expect(f.exec()).rejects.toThrow("locked");
		await f.shutdown();
		expect(f.calls).toHaveLength(0);
	}
});

test("confirmation, TUI restore, current cwd, shutdown and idempotent cleanup", async () => {
	const f = fixture();
	await f.command("unlock 1");
	expect(f.events).toEqual(["idle", "confirm", "stop", "start"]);
	expect(f.calls.slice(0, 3).map((call) => call.args)).toEqual([
		["-k"],
		["-v"],
		["-n", "--", "/usr/bin/true"],
	]);
	expect(f.messages.at(-1)).toContain("unlocked");
	await f.exec();
	expect(f.calls.at(-1)?.cwd).toBe("/tmp");
	await f.shutdown();
	expect(f.calls.at(-1)?.args).toEqual(["-k"]);
	const count = f.calls.length;
	await f.shutdown();
	expect(f.calls).toHaveLength(count);
	await expect(f.exec()).rejects.toThrow("locked");
});

test("declined confirmation invokes no sudo", async () => {
	const f = fixture({ confirm: async () => false });
	await f.command("unlock");
	expect(f.calls).toHaveLength(0);
	expect(f.events).toEqual(["idle", "confirm"]);
	await expect(f.exec()).rejects.toThrow("locked");
});

test("late confirmation cannot unlock after lock or shutdown; concurrent unlock rejected", async () => {
	for (const transition of ["lock", "shutdown"]) {
		let release!: (value: boolean) => void;
		const f = fixture({
			confirm: () =>
				new Promise((resolve) => {
					release = resolve;
				}),
		});
		const pending = f.command("unlock");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await f.command("unlock");
		expect(f.messages.at(-1)).toContain("pending");
		if (transition === "lock") await f.command("lock");
		else await f.shutdown();
		release(true);
		await pending;
		expect(f.calls.some((call) => call.args[0] === "-v")).toBe(false);
		await expect(f.exec()).rejects.toThrow("locked");
	}
});

test("auth failure and spawn failure restore TUI and leave access locked", async () => {
	for (const throws of [false, true]) {
		const f = fixture({
			run: async (invocation) => {
				if (invocation.interactive) {
					if (throws) throw new Error("spawn failure");
					return { ...ok, code: 1 };
				}
				return ok;
			},
		});
		await f.command("unlock");
		expect(f.events.at(-1)).toBe("start");
		expect(f.calls.at(-1)?.args).toEqual(["-k"]);
		await expect(f.exec()).rejects.toThrow("locked");
	}
});

test("TUI restoration failure revokes successful authentication", async () => {
	const f = fixture({ restoreFails: true });
	await f.command("unlock");
	expect(f.messages.at(-1)).toContain("restore failure");
	expect(f.calls.at(-1)?.args).toEqual(["-k"]);
	await expect(f.exec()).rejects.toThrow("locked");
});

test("nonzero tool outcome is an actual Pi tool error and revokes", async () => {
	const f = fixture({
		run: async (invocation) =>
			invocation.args[2] === "/usr/bin/id"
				? { ...ok, code: 2, stderr: "denied" }
				: ok,
	});
	await f.command("unlock");
	await expect(f.exec()).rejects.toThrow("exit=2");
	await expect(f.exec()).rejects.toThrow("locked");
	await f.shutdown();
});

test("askpass is explicit, stays in TUI, and uses only auth invocation", async () => {
	const f = fixture({ askpass: () => "/trusted/helper" });
	await f.command("unlock --askpass");
	expect(f.events).toEqual(["idle", "confirm"]);
	expect(f.calls.map((call) => call.args)).toEqual([
		["-k"],
		["-A", "-v"],
		["-n", "--", "/usr/bin/true"],
	]);
	expect(f.calls[1]).toMatchObject({
		askpass: "/trusted/helper",
		interactive: false,
	});
	await f.exec();
	await f.command("lock");
	expect(f.calls.filter((call) => call.askpass)).toHaveLength(1);
	const defaultMode = fixture({ askpass: () => "/trusted/helper" });
	await defaultMode.command("unlock");
	expect(defaultMode.calls[1].args).toEqual(["-v"]);
	expect(defaultMode.calls[1].askpass).toBeUndefined();
});

test("askpass gating, refusal, recheck, failure and lock during authentication", async () => {
	for (const options of [{ mode: "rpc" }, { tty: false }]) {
		const f = fixture({ ...options, askpass: () => "/trusted/helper" });
		await f.command("unlock --askpass");
		expect(f.calls).toHaveLength(0);
	}
	const absent = fixture({
		askpass: () => undefined,
		resolveAskpass: () => {
			throw Error("missing helper");
		},
	});
	await absent.command("unlock --askpass");
	expect(absent.calls).toHaveLength(0);
	const refused = fixture({
		askpass: () => "/trusted/helper",
		confirm: async () => false,
	});
	await refused.command("unlock 2 --askpass");
	expect(refused.calls).toHaveLength(0);
	let checks = 0;
	const changed = fixture({
		askpass: () => "/trusted/helper",
		resolveAskpass: () => {
			if (++checks === 2) throw Error("changed helper");
			return "/trusted/helper";
		},
	});
	await changed.command("unlock --askpass");
	expect(changed.messages.at(-1)).toContain("changed helper");
	expect(changed.calls.some((call) => call.args.includes("-A"))).toBe(false);
	await expect(changed.exec()).rejects.toThrow("locked");
	let release!: (value: Outcome) => void;
	const pending = fixture({
		askpass: () => "/trusted/helper",
		run: (call) =>
			call.args[0] === "-A"
				? new Promise((resolve) => {
						release = resolve;
					})
				: Promise.resolve(ok),
	});
	const attempt = pending.command("unlock --askpass");
	await new Promise((resolve) => setTimeout(resolve, 0));
	const locking = pending.command("lock");
	expect(pending.calls[1].signal?.aborted).toBe(true);
	release(ok);
	await Promise.all([attempt, locking]);
	await expect(pending.exec()).rejects.toThrow("locked");
});

test("temporary host failure revokes grant without spawning unsafe cleanup", async () => {
	let valid = true;
	const f = fixture({
		host: () => {
			if (!valid) throw Error("host unavailable");
		},
	});
	await f.command("unlock");
	valid = false;
	await f.command("lock");
	expect(f.messages.at(-1)).toContain("host unavailable");
	valid = true;
	await expect(f.exec()).rejects.toThrow("locked");
	expect(f.calls).toHaveLength(3);
});

test("tool error preserves command result and bounded cleanup warning", async () => {
	let invalidate = 0;
	const f = fixture({
		run: async (call) => {
			if (call.args[0] === "-k" && ++invalidate > 1) return { ...ok, code: 1 };
			return call.args[2] === "/usr/bin/id"
				? { ...ok, code: 7, stderr: "failure" }
				: ok;
		},
	});
	await f.command("unlock");
	await expect(f.exec()).rejects.toThrow(
		/exit=7[\s\S]*cleanup failed[\s\S]*failure/,
	);
});

test("askpass failure and helper substitution never grant or fall back", async () => {
	const failed = fixture({
		askpass: () => "/trusted/helper",
		run: async (call) =>
			call.args[0] === "-A" ? { ...ok, code: 1, stderr: "PRIVATE-CANARY" } : ok,
	});
	await failed.command("unlock --askpass");
	expect(failed.messages.join(" ")).not.toContain("PRIVATE-CANARY");
	expect(failed.calls.at(-1)?.args).toEqual(["-k"]);
	await expect(failed.exec()).rejects.toThrow("locked");
	let helper = "/trusted/helper";
	// The second resolution cannot silently substitute another trusted helper.
	const swapped = fixture({
		askpass: () => helper,
		resolveAskpass: () => {
			const result = helper;
			helper = "/trusted/other";
			return result;
		},
	});
	await swapped.command("unlock --askpass");
	expect(swapped.calls.some((call) => call.args.includes("-A"))).toBe(false);
	await expect(swapped.exec()).rejects.toThrow("locked");
});
