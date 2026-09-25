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
		() => {},
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
		exec: () =>
			tool.execute(
				"id",
				{ executable: "/usr/bin/id", args: [] },
				undefined,
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
