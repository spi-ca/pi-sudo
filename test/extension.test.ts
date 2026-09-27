import { test, expect } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.js";
import { runProcess, type Invocation, type Outcome, type Runner } from "../src/process.js";
import type { Clock } from "../src/sudo.js";
import { Container, CURSOR_MARKER, TuiMainScreen, TuiAltScreen, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";


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
		approvalKeys?: string[];
		run?: Runner;
		restoreFails?: boolean;
		tui?: TUI;
		missingHandoff?: boolean;
		stopFails?: boolean;
		columns?: number;
		rows?: number;
		inspectApproval?: boolean;
		resizeApproval?: { columns: number; rows: number }[];
		resizeBeforeInput?: { columns: number; rows: number };
		bindings?: Record<string, string[]>;
		realBindings?: boolean;
		dockFooterRows?: number;
		belowWidgetRows?: number;
		host?: () => void;
		askpass?: () => string | undefined;
		resolveAskpass?: (value: string | undefined) => string;
		clock?: Clock;
	} = {},
) {
	const calls: Invocation[] = [];
	const events: string[] = [];
	const messages: string[] = [];
	const warnings: string[] = [];
	const approvalScreens: string[][] = [];
	const approvalFrames: string[][] = [];
	const statuses: { color: string; text: string }[] = [];
	const boldLabels: string[] = [];
	let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	let startup!: (event: { type: "session_start" }, ctx: ExtensionContext) => void;
	let shutdown!: (
		event: { type: "session_shutdown" },
		ctx: ExtensionContext,
	) => Promise<void>;
	let tool!: ToolDefinition;
	const pi = {
		registerCommand: (_name: string, options: { handler: typeof command }) => {
			command = options.handler;
		},
		registerTool: (value: typeof tool) => {
			tool = value;
		},
		on: (name: string, handler: typeof shutdown) => {
			if (name === "session_shutdown") shutdown = handler;
			if (name === "session_start") startup = handler as unknown as typeof startup;
			return () => {};
		},
	} as unknown as ExtensionAPI;
	extension(
		pi,
		async (invocation) => {
			calls.push(invocation);
			if (invocation.args[0] === "-v" && !options.tui) expect(events.at(-1)).toBe("stop");
			return options.run ? options.run(invocation) : ok;
		},
		() => options.tty ?? true,
		options.host ?? (() => {}),
		options.askpass ?? (() => undefined),
		options.resolveAskpass ?? (() => "/trusted/helper"),
		options.clock,
		options.clock,
	);
	const ctx = {
		mode: options.mode ?? "tui",
		cwd: "/tmp",
		waitForIdle: async () => {
			events.push("idle");
		},
		ui: {
			theme: {
				fg: (color: string, text: string) => JSON.stringify({ color, text }),
				bold: (text: string) => { boldLabels.push(text); return text; },
			},
			notify: (message: string) => {
				messages.push(message);
			},
			setStatus: (_key: string, text: string | undefined) => {
				statuses.push(text === undefined ? { color: "clear", text: "" } : JSON.parse(text));
			},
			custom: async (factory: (...args: any[]) => unknown) => {
				let resolve!: (value: unknown) => void;
				const result = new Promise<unknown>((done) => { resolve = done; });
				const tui = options.tui ?? {
					mode: "regular",
					children: [new Container()],
					terminal: { write: (_data: string) => {}, columns: options.columns ?? 80, rows: options.rows ?? 24 },
					...options.missingHandoff ? {} : {
						captureRenderState: () => ({ previousLines: [], previousWidth: 0, previousHeight: 0,
							cursorRow: 0, hardwareCursorRow: 0, maxLinesRendered: 0, previousViewportTop: 0 }),
						restoreRenderState: (_state: unknown) => {},
					},
					stop: (args: unknown) => {
						if (args !== undefined) throw new Error("regular stop must not preserve screen");
						events.push("stop");
						if (options.stopFails) throw new Error("stop failure");
					},
					start: () => {
						events.push("start");
						if (options.restoreFails) throw new Error("restore failure");
					},
					requestRender: () => {},
				};
				const bindings = options.bindings ?? {};
				const defaults: Record<string, string[]> = { "tui.select.up": ["up"], "tui.select.down": ["down"],
					"tui.select.confirm": ["enter"], "tui.select.cancel": ["escape", "ctrl+c"] };
				const raw: Record<string, string> = { up: "\u001b[A", down: "\u001b[B", enter: "\r", escape: "\u001b", "ctrl+c": "\u0003", "ctrl+y": "\u0019", "ctrl+j": "\n", "2": "2" };
				const keybindings = {
					getKeys: (name: string) => bindings[name] ?? defaults[name] ?? [],
					matches: (data: string, name: string) => (bindings[name] ?? defaults[name] ?? []).some(key => raw[key] === data),
				};
				const component = factory(tui, { fg: (_color: string, text: string) => text }, options.realBindings ? getKeybindings() : keybindings, resolve,
				) as { render: (width: number) => string[]; invalidate: () => void; handleInput?: (key: string) => void };
				if (component.handleInput) {
					// The real Pi host mounts custom() in its editor container before dispatching input.
					if (options.tui && options.dockFooterRows !== undefined) {
						const document = new Container();
						document.addChild({ render: () => Array(40).fill("transcript"), invalidate() {} });
						const editor = new Container();
						editor.addChild(component);
						const footer = new Container();
						footer.addChild({ render: () => Array(options.dockFooterRows).fill("footer"), invalidate() {} });
						const pendingMessages = new Container(), status = new Container();
						const widgetsAbove = new Container(), widgetsBelow = new Container();
						widgetsBelow.addChild({ render: () => Array(options.belowWidgetRows ?? 0).fill("widget"), invalidate() {} });
						// Match InteractiveMode.mountInteractiveTui and its fullscreen root.
						for (const child of [document, pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer])
							options.tui.addChild(child);
						if (options.tui instanceof TuiAltScreen) options.tui.setLayoutRoot(createChatViewport({ document, editor, footer,
							pendingMessages, status, widgetsAbove, widgetsBelow }).root);
					} else if (options.tui) options.tui.addChild(component);
					else tui.children.push(component as any);
					events.push("confirm");
					const sizes = [{ columns: tui.terminal.columns, rows: tui.terminal.rows }, ...options.resizeApproval ?? []];
					for (const size of sizes) {
						Object.assign(tui.terminal, size);
						options.tui?.renderNow();
						approvalFrames.push(component.render(size.columns));
					}
					const warning = approvalFrames.at(-1)!.join("\n");
					warnings.push(warning);
					approvalScreens.push(component.render(20));
					component.render(tui.terminal.columns);
					if (options.resizeBeforeInput) Object.assign(tui.terminal, options.resizeBeforeInput);
					void (async () => {
						const keys = options.approvalKeys ?? [(options.confirm ? await options.confirm() : true) ? "2" : "1", "\r"];
						for (const key of keys) component.handleInput!(key);
					})();
				}

				return result;
			},
		},
	} as unknown as ExtensionCommandContext;
	return {
		calls,
		events,
		messages,
		warnings,
		approvalScreens,
		approvalFrames,
		statuses,
		boldLabels,
		startup: () => startup({ type: "session_start" }, ctx),
		command: (args: string) => command(args, ctx),
		renderCall: tool.renderCall!,
		exec: (signal?: AbortSignal, onUpdate?: Parameters<ToolDefinition["execute"]>[3], id = "id") =>
			tool.execute(
				id,
				{ executable: "/usr/bin/id", args: [] },
				signal,
				onUpdate,
				ctx,
			),
		shutdown: () => shutdown({ type: "session_shutdown" }, ctx),
	};
}

class RecordingTerminal implements Terminal {
	writes: string[] = [];
	columns = 80;
	rows = 12;
	kittyProtocolActive = false;
	start() {}
	stop() {}
	drainInput = async () => {};
	write(data: string) { this.writes.push(data); }
	moveBy(_lines: number) {}
	hideCursor() { this.write("\x1b[?25l"); }
	showCursor() { this.write("\x1b[?25h"); }
	clearLine() { this.write("\x1b[2K"); }
	clearFromCursor() { this.write("\x1b[J"); }
	clearScreen() { this.write("\x1b[2J"); }
	setTitle(_title: string) {}
	setProgress(_active: boolean) {}
}

test("real regular/fullscreen TUI handoff keeps regular scrollback and fullscreen transcript private", async () => {
	for (const mode of ["regular", "fullscreen"] as const) {
		for (const outcome of ["success", "failure", "cancel"] as const) {
			const terminal = new RecordingTerminal();
			terminal.rows = 24;
			const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
			tui.addChild({ render: () => ["TRANSCRIPT-CANARY", `EDITOR${CURSOR_MARKER}`, "FOOTER-CANARY"], invalidate() {} });
			tui.start();
			tui.renderNow();
			terminal.writes = [];
			const f = fixture({ tui, run: async (call) => {
				if (call.args[0] === "-v") {
					terminal.write("sudo output\r\n".repeat(30)); // scroll beyond the old UI coordinates
					terminal.write("PARTIAL-PROMPT"); // a killed child need not finish its last line
					return outcome === "success" ? ok : { ...ok, code: 1, cancelled: outcome === "cancel" };
				}
				return ok;
			} });
			await f.command("unlock");
			tui.renderNow();
			const output = terminal.writes.join("");
			const notice = "Authenticate with sudo in this terminal (not Pi).";
			const noticeAt = output.indexOf(notice);
			expect(noticeAt).toBeGreaterThanOrEqual(0);
			if (mode === "regular") {
				// Public regular stop moves past the old footer before the static notice.
				expect(output.slice(0, noticeAt)).toMatch(/\x1b\[\d+B\r\n/);
				expect(output).not.toContain("\x1b[3J");
				expect(output).not.toContain("\x1b[2J");
				expect(output).toContain("PARTIAL-PROMPT\r\n");
				expect(output.slice(noticeAt)).toContain("FOOTER-CANARY"); // one fresh redraw
			} else {
				const handoff = output.slice(0, noticeAt);
				expect(handoff).toContain("\x1b[?1049l");
				expect(handoff).not.toContain("TRANSCRIPT-CANARY");
			}
			if (outcome === "success") expect(f.messages.at(-1)).toContain("grant open");
			else {
				expect(f.messages.at(-1)).not.toContain("grant open");
				await expect(f.exec()).rejects.toThrow("locked");
			}
			await f.shutdown();
			tui.stop({ preserveScreen: true });
		}
	}
});

test("OS SIGINT to Pi during non-detached auth cancels the child, restores TUI and removes handler", async () => {
	const listeners = process.listenerCount("SIGINT");
	let childResult: Outcome | undefined;
	const f = fixture({ run: async (call) => {
		if (call.args[0] !== "-v") return ok;
		const child = runProcess({ ...call, executable: process.execPath,
			args: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 3000 });
		setTimeout(() => process.kill(process.pid, "SIGINT"), 70);
		childResult = await child;
		return childResult;
	} });
	try {
		await f.command("unlock");
		expect(childResult?.cancelled).toBe(true);
		expect(f.calls.map(call => call.args)).toContainEqual(["-v"]);
		expect(f.events.at(-1)).toBe("start");
		expect(f.messages.at(-1)).not.toContain("grant open");
		await expect(f.exec()).rejects.toThrow("locked");
		await f.command("status");
		expect(f.messages.at(-1)).toBe("sudo locked");
	} finally {
		expect(process.listenerCount("SIGINT")).toBe(listeners);
	}
});

test("SIGINT in initial invalidation or probe also fails closed and removes handler", async () => {
	for (const stage of ["-k", "-n"]) {
		const before = process.listenerCount("SIGINT");
		let sent = false;
		const f = fixture({ run: async (call) => {
			if (call.args[0] === stage && !sent) {
				sent = true;
				await new Promise<void>(resolve => setTimeout(() => { process.emit("SIGINT"); resolve(); }, 0));
			}
			return ok;
		} });
		await f.command("unlock");
		expect(f.events.at(-1)).toBe("start");
		expect(f.messages.at(-1)).not.toContain("grant open");
		await expect(f.exec()).rejects.toThrow("locked");
		expect(process.listenerCount("SIGINT")).toBe(before);
	}
});

test("inline consent fits real regular/fullscreen editor slots or fails closed after resize", async () => {
	for (const Screen of [TuiMainScreen, TuiAltScreen]) {
		const terminal = new RecordingTerminal();
		terminal.columns = 80;
		terminal.rows = 24;
		const tui = new Screen(terminal);
		tui.addChild({ render: () => ["transcript"], invalidate() {} });
		tui.start();
		try {
			const f = fixture({ tui, resizeApproval: [{ columns: 30, rows: 10 }, { columns: 80, rows: 24 }], approvalKeys: ["\u001b"] });
			await f.command("unlock");
			expect(f.approvalFrames[0].join(" ")).toContain("2. YES");
			expect(f.approvalFrames[1].join(" ")).toContain("Resize / Esc");
			for (const [i, size] of [{ columns: 80, rows: 24 }, { columns: 30, rows: 10 }, { columns: 80, rows: 24 }].entries()) {
				expect(f.approvalFrames[i].length).toBeLessThanOrEqual(size.rows - 5);
				expect(f.approvalFrames[i].every(line => visibleWidth(line) <= size.columns)).toBe(true);
			}
			expect(f.calls).toHaveLength(0);
		} finally { tui.stop({ preserveScreen: true }); }
	}
});

test("resize followed by batched YES and Enter cannot approve before new consent renders", async () => {
	for (const Screen of [TuiMainScreen, TuiAltScreen]) {
		for (const initialRows of [10, 24]) {
			const terminal = new RecordingTerminal();
			terminal.rows = initialRows;
			const tui = new Screen(terminal);
			tui.addChild({ render: () => ["transcript"], invalidate() {} });
			tui.start();
			try {
				const f = fixture({ tui, resizeBeforeInput: { columns: 80, rows: 30 },
					approvalKeys: ["2", "\r", "\u001b"] });
				await f.command("unlock");
				expect(f.calls).toHaveLength(0);
			} finally { tui.stop({ preserveScreen: true }); }
		}
	}
});

test("long helper wraps entirely in a tall editor without hiding warnings or choices", async () => {
	const helper = `/trusted/${"long-helper-".repeat(10)}`;
	const f = fixture({ columns: 48, rows: 38, askpass: () => helper, resolveAskpass: () => helper,
		approvalKeys: ["\u001b"] });
	await f.command("unlock");
	const frame = f.approvalFrames[0];
	expect(frame.length).toBeLessThanOrEqual(33);
	expect(frame.every(line => visibleWidth(line) <= 48)).toBe(true);
	expect(frame.join("\n")).toContain("2. YES");
	expect(frame.join("\n").match(/• /g)).toHaveLength(4);
	expect(f.calls).toHaveLength(0);
});

test("a resize after YES selection cannot confirm hidden consent", async () => {
	const f = fixture({ resizeApproval: [{ columns: 32, rows: 8 }], approvalKeys: ["2", "\r", "\u001b"] });
	await f.command("unlock");
	expect(f.calls).toHaveLength(0);
	expect(f.approvalFrames.at(-1)!.join(" ")).toContain("Resize / Esc");
});

test("unseen consent never approves, including long helper and resized narrow screen", async () => {
	const f = fixture({ columns: 38, rows: 14, askpass: () => "/trusted/helper", resolveAskpass: () => "/trusted/" + "x".repeat(300),
		approvalKeys: ["2", "\r", "\u001b"] });
	await f.command("unlock");
	expect(f.calls).toHaveLength(0);
	expect(f.warnings[0]).toContain("Resize / Esc");
});

test("installed Pi select bindings confirm only after YES is selected", async () => {
	const f = fixture({ realBindings: true, approvalKeys: ["2", "\r"] });
	await f.command("unlock");
	expect(f.calls[1]?.args).toEqual(["-v"]);
});

test("numeric shortcuts cannot become confirmation even when a select key is rebound", async () => {
	const f = fixture({ bindings: { "tui.select.confirm": ["2"] }, approvalKeys: ["2", "\u001b"] });
	await f.command("unlock");
	expect(f.calls).toHaveLength(0);
});

test("real fullscreen dock admits visible consent but rejects consent clipped by a competing footer", async () => {
	for (const footerRows of [2, 24]) {
		const terminal = new RecordingTerminal();
		terminal.rows = 24;
		const tui = new TuiAltScreen(terminal);
		tui.start();
		const f = fixture({ tui, dockFooterRows: footerRows, approvalKeys: ["2", "\r", "\u001b"] });
		try {
			await f.command("unlock");
			if (footerRows === 2) expect(f.calls[1]?.args).toEqual(["-v"]);
			else {
				expect(f.calls).toHaveLength(0);
				expect(f.messages.at(-1)).toContain("consent is clipped");
			}
		} finally { await f.shutdown(); tui.stop({ preserveScreen: true }); }
	}
});

test("below-editor widgets cannot push consent disclosures off-screen in either mode", async () => {
	for (const Screen of [TuiMainScreen, TuiAltScreen]) {
		for (const belowWidgetRows of [0, 12, 24]) {
			const terminal = new RecordingTerminal();
			terminal.rows = 24;
			const tui = new Screen(terminal);
			tui.start();
			const f = fixture({ tui, dockFooterRows: 2, belowWidgetRows, approvalKeys: ["2", "\r", "\u001b"] });
			try {
				await f.command("unlock");
				if (belowWidgetRows === 0) expect(f.calls[1]?.args).toEqual(["-v"]);
				else {
					expect(f.calls).toHaveLength(0);
					expect(f.messages.at(-1)).toContain("consent is clipped");
				}
			} finally { await f.shutdown(); tui.stop({ preserveScreen: true }); }
		}
	}
});

test("configured Pi select bindings are authoritative; digits only move selection", async () => {
	const bindings = { "tui.select.confirm": ["ctrl+y"], "tui.select.cancel": ["ctrl+c"],
		"tui.select.up": ["ctrl+j"], "tui.select.down": ["down"] };
	for (const keys of [["2", "\r", "\u0003"], ["2", "\u001b"]]) {
		const f = fixture({ bindings, approvalKeys: keys });
		await f.command("unlock");
		expect(f.calls).toHaveLength(0);
		expect(f.warnings[0]).toContain("Ctrl+Y confirm");
	}
	const f = fixture({ bindings, approvalKeys: ["2", "\u0019"] });
	await f.command("unlock");
	expect(f.calls[1]?.args).toEqual(["-v"]);
});

test("missing regular render-state capability fails closed before sudo", async () => {
	const f = fixture({ missingHandoff: true });
	await f.command("unlock");
	expect(f.calls).toHaveLength(0);
	expect(f.messages.at(-1)).toContain("safe terminal authentication handoff");
	await expect(f.exec()).rejects.toThrow("locked");
	await f.shutdown();
	expect(f.calls).toHaveLength(0);
});

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
	expect(f.warnings[0]).toContain("up to 1 minute(s)?\nAuthentication: terminal");
	expect(f.events).toEqual(["idle", "confirm", "stop", "start"]);
	expect(f.calls.slice(0, 3).map((call) => call.args)).toEqual([
		["-k"],
		["-v"],
		["-n", "--", "/usr/bin/true"],
	]);
	expect(f.messages.at(-1)).toContain("grant open");
	const progress: unknown[] = [];
	await f.exec(undefined, (update) => progress.push(update.content));
	expect(progress).toEqual([[{ type: "text", text: "Checking access and running command…" }]]);
	expect(f.calls.at(-1)?.cwd).toBe("/tmp");
	await f.shutdown();
	expect(f.calls.at(-1)?.args).toEqual(["-k"]);
	const count = f.calls.length;
	await f.shutdown();
	expect(f.calls).toHaveLength(count);
	await expect(f.exec()).rejects.toThrow("locked");
});

test("only authorized execution forwards bounded partial output, without changing final result", async () => {
	const f = fixture({ run: async (call) => {
		if (call.args[2] === "/usr/bin/id") {
			call.onOutput?.({ stdout: "live", stderr: "\x1b[2J" + "x".repeat(80000), truncated: true });
			return { ...ok, stdout: "live", stderr: "done" };
		}
		expect(call.onOutput).toBeUndefined();
		return ok;
	} });
	await expect(f.exec()).rejects.toThrow("locked");
	await f.command("unlock");
	const updates: unknown[] = [];
	const final = await f.exec(undefined, (update) => updates.push(update));
	expect(updates).toHaveLength(2);
	expect(updates[1]).toMatchObject({ details: { streaming: true, truncated: true } });
	expect(Buffer.byteLength((updates[1] as { content: { text: string }[] }).content[0].text)).toBeLessThanOrEqual(48 * 1024);
	expect(final).toMatchObject({ content: [{ text: "exit=0, cancelled=false, timedOut=false, truncated=false\nlive\ndone" }] });
	await f.shutdown();
});

test("mixed pipes use ordered display metadata on success and bounded error text on failure", async () => {
	let fail = false;
	const f = fixture({ run: async (call) => {
		if (call.args[2] !== "/usr/bin/id") return ok;
		call.onOutput?.({ stdout: "stdout prefix", stderr: "stderr prefix", truncated: false,
			displayOutput: "err-first\nout-last", displayTruncated: false });
		return { ...ok, code: fail ? 3 : 0, stdout: "stdout prefix", stderr: "stderr prefix",
			displayOutput: "err-first\nout-last", displayTruncated: false };
	} });
	await f.command("unlock");
	const updates: unknown[] = [];
	const success = await f.exec(undefined, (update) => updates.push(update));
	expect(updates[1]).toMatchObject({ content: [{ text: "err-first\nout-last" }], details: { displayOutput: "err-first\nout-last" } });
	expect(success).toMatchObject({ content: [{ text: "exit=0, cancelled=false, timedOut=false, truncated=false\nstdout prefix\nstderr prefix" }],
		details: { displayOutput: "err-first\nout-last" } });
	fail = true;
	await expect(f.exec()).rejects.toThrow("exit=3, cancelled=false, timedOut=false, truncated=false\nerr-first\nout-last");
	await expect(f.exec()).rejects.toThrow("locked");
	await f.shutdown();
});

test("thrown transport error keeps the last ordered streamed tail without details", async () => {
	const f = fixture({ run: async (call) => {
		if (call.args[2] !== "/usr/bin/id") return ok;
		call.onOutput?.({ stdout: "out", stderr: "err", truncated: false,
			displayOutput: "err-before\nout-after", displayTruncated: false });
		throw new Error("transport failed");
	} });
	await f.command("unlock");
	const updates: unknown[] = [];
	await expect(f.exec(undefined, (update) => updates.push(update))).rejects.toThrow("transport failed\nerr-before\nout-after");
	expect(updates.at(-1)).toMatchObject({ details: { displayOutput: "err-before\nout-after" } });
	await expect(f.exec()).rejects.toThrow("locked");
	await f.shutdown();
});

test("approval defaults NO, numeric selection requires Enter, arrows and cancel fail closed", async () => {
	for (const keys of [["\r"], ["2", "1", "\r"], ["\u001b[A", "\r"], ["\u001b"], ["\u0003"]]) {
		const f = fixture({ approvalKeys: keys });
		await f.command("unlock 180");
		expect(f.calls).toHaveLength(0);
		expect(f.warnings[0]).toContain("up to 180 minute(s)");
		expect(f.approvalScreens[0].every((line) => visibleWidth(line) <= 20)).toBe(true);
	}
	for (const keys of [["2", "\r"], ["\u001b[B", "\r"]]) {
		const f = fixture({ approvalKeys: keys });
		await f.command("unlock 180");
		expect(f.calls[1]?.args).toEqual(["-v"]);
		await f.command("lock");
	}
});

test("malformed duration rejects before approval or sudo", async () => {
	for (const arg of ["0", "181", "01", "1.5", "+1", "180x", "Infinity"]) {
		const f = fixture();
		await f.command(`unlock ${arg}`);
		expect(f.warnings).toHaveLength(0);
		expect(f.calls).toHaveLength(0);
		expect(f.messages.at(-1)).toContain("1 to 180");
	}
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

test("stop failure attempts restoration and revokes without authentication", async () => {
	const f = fixture({ stopFails: true });
	await f.command("unlock");
	expect(f.events).toEqual(["idle", "confirm", "stop", "start"]);
	expect(f.calls).toHaveLength(0);
	expect(f.messages.at(-1)).toContain("stop failure");
	await expect(f.exec()).rejects.toThrow("locked");
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
		run: async (invocation) => {
			if (invocation.args[2] !== "/usr/bin/id") return ok;
			invocation.onOutput?.({ stdout: "", stderr: "denied", truncated: false });
			return { ...ok, code: 2, stderr: "denied" };
		},
	});
	await f.command("unlock");
	const updates: unknown[] = [];
	await expect(f.exec(undefined, (update) => updates.push(update))).rejects.toThrow("exit=2");
	expect(updates).toHaveLength(2);
	expect(updates[1]).toMatchObject({ content: [{ text: "denied" }] });
	await expect(f.exec()).rejects.toThrow("locked");
	await f.shutdown();
});

test("configured askpass is automatic, stays in TUI, and uses only auth invocation", async () => {
	const f = fixture({ askpass: () => "/trusted/helper" });
	await f.command("unlock");
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
	const defaultMode = fixture();
	await defaultMode.command("unlock");
	expect(defaultMode.calls[1].args).toEqual(["-v"]);
	expect(defaultMode.calls[1].askpass).toBeUndefined();
});

test("askpass helper control characters are escaped in the approval screen", async () => {
	const f = fixture({ askpass: () => "/trusted/helper\u001b[2J", resolveAskpass: (value) => value! });
	await f.command("unlock 1");
	expect(f.warnings[0]).toContain("/trusted/helper\\u001b[2J");
	expect(f.warnings[0]).not.toContain("\u001b");
	expect(f.calls[1]?.askpass).toBe("/trusted/helper\u001b[2J");
});

test("retained --askpass alias requires SUDO_ASKPASS without terminal fallback", async () => {
	for (const command of ["unlock --askpass", "unlock 1 --askpass"]) {
		const absent = fixture();
		await absent.command(command);
		expect(absent.messages.at(-1)).toContain("--askpass requires SUDO_ASKPASS");
		expect(absent.events).toEqual([]);
		expect(absent.warnings).toEqual([]);
		expect(absent.calls).toEqual([]);
		await expect(absent.exec()).rejects.toThrow("locked");

		const configured = fixture({ askpass: () => "/trusted/helper" });
		await configured.command(command);
		expect(configured.events).toEqual(["idle", "confirm"]);
		expect(configured.warnings[0]).toContain("Authentication: OS askpass (/trusted/helper)");
		expect(configured.calls.map((call) => call.args)).toEqual([
			["-k"], ["-A", "-v"], ["-n", "--", "/usr/bin/true"],
		]);
	}
	const empty = fixture({
		askpass: () => "",
		resolveAskpass: () => { throw Error("invalid helper"); },
	});
	await empty.command("unlock --askpass");
	expect(empty.messages.at(-1)).toContain("invalid helper");
	expect(empty.events).toEqual([]);
	expect(empty.warnings).toEqual([]);
	expect(empty.calls).toEqual([]);

	const normal = fixture();
	await normal.command("unlock");
	expect(normal.warnings[0]).toContain("Authentication: terminal");
	expect(normal.events).toEqual(["idle", "confirm", "stop", "start"]);
	expect(normal.calls[1]?.args).toEqual(["-v"]);
});

test("askpass gating, refusal, recheck, failure and lock during authentication", async () => {
	for (const options of [{ mode: "rpc" }, { tty: false }]) {
		const f = fixture({ ...options, askpass: () => "/trusted/helper" });
		await f.command("unlock");
		expect(f.calls).toHaveLength(0);
	}
	const absent = fixture({
		askpass: () => undefined,
		resolveAskpass: () => {
			throw Error("missing helper");
		},
	});
	await absent.command("unlock");
	expect(absent.calls[1]?.args).toEqual(["-v"]);
	const invalid = fixture({
		askpass: () => "relative/helper",
		resolveAskpass: () => { throw Error("untrusted helper"); },
	});
	await invalid.command("unlock");
	expect(invalid.calls).toHaveLength(0);
	expect(invalid.warnings).toHaveLength(0);
	expect(invalid.messages.at(-1)).toContain("untrusted helper");
	const refused = fixture({
		askpass: () => "/trusted/helper",
		confirm: async () => false,
	});
	await refused.command("unlock 2");
	expect(refused.warnings[0]).toContain("up to 2 minute(s)?\nAuthentication: OS askpass (/trusted/helper)");
	expect(refused.calls).toHaveLength(0);
	let checks = 0;
	const changed = fixture({
		askpass: () => "/trusted/helper",
		resolveAskpass: () => {
			if (++checks === 2) throw Error("changed helper");
			return "/trusted/helper";
		},
	});
	await changed.command("unlock");
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
	const attempt = pending.command("unlock");
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
	await failed.command("unlock");
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
	await swapped.command("unlock");
	expect(swapped.calls.some((call) => call.args.includes("-A"))).toBe(false);
	await expect(swapped.exec()).rejects.toThrow("locked");
	let env = "/trusted/helper";
	// Confirmation is the boundary between selection and authentication.
	const rechecked = fixture({ askpass: () => env, resolveAskpass: (value) => {
		if (!value) throw Error("invalid helper");
		return value;
	}, confirm: async () => { env = ""; return true; } });
	await rechecked.command("unlock");
	expect(rechecked.calls.some((call) => call.args.includes("-A"))).toBe(false);
	await expect(rechecked.exec()).rejects.toThrow("locked");
});

function fakeClock() {
	let time = 0;
	let next = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	const scheduler = {
		now: () => time,
		wallNow: () => time,
		setTimeout: (callback: () => void, delay: number) => {
			const id = ++next;
			timers.set(id, { at: time + delay, callback });
			return { unref() {}, id } as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: (timer: ReturnType<typeof setTimeout>) => { timers.delete((timer as unknown as { id: number }).id); },
	};
	return {
		scheduler,
		count: () => timers.size,
		advance(ms: number) {
			const end = time + ms;
			for (;;) {
				const due = [...timers].filter(([, timer]) => timer.at <= end)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				time = due[1].at;
				timers.delete(due[0]);
				due[1].callback();
			}
			time = end;
		},
	};
}

test("locked status stays hidden, pending is not a grant, duplicate unlock cannot mask a grant", async () => {
	const clock = fakeClock();
	let release!: (approved: boolean) => void;
	const f = fixture({ clock: clock.scheduler, confirm: () => new Promise((resolve) => { release = resolve; }) });
	f.startup();
	expect(f.statuses.at(-1)).toEqual({ color: "clear", text: "" });
	const pending = f.command("unlock 1");
	await Promise.resolve();
	expect(f.statuses.at(-1)).toEqual({ color: "warning", text: "⏳ sudo" });
	release(false);
	await pending;
	expect(f.statuses.at(-1)?.text).toBe("");
	const unlock = f.command("unlock 1");
	await new Promise((resolve) => setTimeout(resolve, 0));
	release(true);
	await unlock;
	expect(f.statuses.at(-1)).toEqual({ color: "warning", text: "⚡ sudo grant ≤1:00" });
	const count = f.calls.length;
	await f.command("unlock 1");
	expect(f.messages.at(-1)).toContain("Already unlocked");
	expect(f.statuses.at(-1)?.text).toBe("⚡ sudo grant ≤1:00");
	expect(f.statuses.at(-1)?.text).toBe("⚡ sudo grant ≤1:00");
	expect(f.calls).toHaveLength(count);
	clock.advance(29_000);
	expect(f.statuses.at(-1)?.text).toBe("⚡ sudo grant ≤0:31");
	clock.advance(1_000);
	expect(f.statuses.at(-1)).toEqual({ color: "warning", text: "⚡ sudo grant ≤0:30" });
	expect(f.boldLabels.at(-1)).toBe("⚡ sudo grant ≤0:30");
	expect(f.calls).toHaveLength(count);
	await f.command("lock");
	expect(f.statuses.at(-1)?.text).toBe("");
	expect(clock.count()).toBe(0);
	await f.shutdown();
	expect(f.statuses.at(-1)?.color).toBe("clear");
});

test("revocation and shutdown fence pending UI and leave no refresh", async () => {
	for (const transition of ["lock", "shutdown"]) {
		const clock = fakeClock();
		let release!: (approved: boolean) => void;
		const f = fixture({ clock: clock.scheduler, confirm: () => new Promise((resolve) => { release = resolve; }) });
		f.startup();
		const unlock = f.command("unlock");
		await Promise.resolve();
		expect(f.statuses.at(-1)?.text).toBe("⏳ sudo");
		await (transition === "lock" ? f.command("lock") : f.shutdown());
		release(true);
		await unlock;
		expect(f.statuses.at(-1)?.text).toBe("");
		expect(clock.count()).toBe(0);
	}
});

test("cache cleanup warning persists through status until successful lock", async () => {
	const clock = fakeClock();
	let invalidations = 0;
	const f = fixture({ clock: clock.scheduler, run: async (call) => {
		if (call.args[0] === "-k" && ++invalidations === 2) return { ...ok, code: 1 };
		return call.args[2] === "/usr/bin/id" ? { ...ok, code: 2 } : ok;
	} });
	f.startup();
	await f.command("unlock 1");
	await expect(f.exec()).rejects.toThrow("cleanup failed");
	expect(f.statuses.at(-1)).toEqual({ color: "error", text: "⚠️ sudo" });
	await f.command("status");
	expect(f.statuses.at(-1)?.text).toBe("⚠️ sudo");
	await f.command("lock");
	expect(f.statuses.at(-1)).toEqual({ color: "clear", text: "" });
	await f.shutdown();
});

test("expiry stops lightning and failed expiry invalidation shows warning", async () => {
	const clock = fakeClock();
	let invalidations = 0;
	const f = fixture({ clock: clock.scheduler, run: async (call) =>
		call.args[0] === "-k" && ++invalidations === 2 ? { ...ok, code: 1 } : ok });
	f.startup();
	await f.command("unlock 1");
	clock.advance(60_000);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(f.statuses.at(-1)).toEqual({ color: "error", text: "⚠️ sudo" });
	expect(f.statuses.some(({ text }) => text === "⚡ sudo grant ≤0:00")).toBe(false);
	expect(clock.count()).toBe(0);
	await f.shutdown();
});

test("failed unlock cleanup and lock/host invalidation expose cache warning, not success", async () => {
	const failedAuth = fixture({ run: async (call) => {
		if (call.args[0] === "-k") return call.interactive ? ok : { ...ok, code: 1 };
		return ok;
	} });
	failedAuth.startup();
	await failedAuth.command("unlock");
	expect(failedAuth.statuses.at(-1)).toEqual({ color: "error", text: "⚠️ sudo" });
	await failedAuth.command("status");
	expect(failedAuth.statuses.at(-1)?.text).toBe("⚠️ sudo");
	await failedAuth.shutdown();

	let hostValid = true;
	const host = fixture({ host: () => { if (!hostValid) throw Error("host unavailable"); } });
	host.startup();
	await host.command("unlock");
	hostValid = false;
	await host.command("lock");
	expect(host.statuses.at(-1)).toEqual({ color: "error", text: "⚠️ sudo" });
	await host.shutdown();
});

test("thrown execution cleanup error shows warning and no lingering grant", async () => {
	let invalidations = 0;
	const f = fixture({ run: async (call) => {
		if (call.args[0] === "-k") return ++invalidations === 2 ? { ...ok, code: 1 } : ok;
		if (call.args[2] === "/usr/bin/id") throw Error("spawn failure");
		return ok;
	} });
	f.startup();
	await f.command("unlock");
	await expect(f.exec()).rejects.toThrow("cleanup failed");
	expect(f.statuses.at(-1)).toEqual({ color: "error", text: "⚠️ sudo" });
	await f.shutdown();
});

test("initial invalidation spawn failure and restoration cleanup failure warn", async () => {
	const initial = fixture({ run: async () => { throw Error("spawn failure"); } });
	initial.startup();
	await initial.command("unlock");
	expect(initial.statuses.at(-1)?.text).toBe("⚠️ sudo");
	await initial.shutdown();
	let invalidations = 0;
	const restore = fixture({ restoreFails: true, run: async (call) => {
		if (call.args[0] === "-k" && ++invalidations === 2) throw Error("cleanup spawn failure");
		return ok;
	} });
	restore.startup();
	await restore.command("unlock");
	expect(restore.statuses.at(-1)?.text).toBe("⚠️ sudo");
	expect(restore.messages.at(-1)).toContain("cleanup spawn failure");
	await restore.shutdown();
});

test("print executions leave no spinner IDs; live cancellation and shutdown stop timers", async () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Parameters<NonNullable<ToolDefinition["renderCall"]>>[1];
	let ticks = 0;
	const context = (id: string) => ({ cwd: "/tmp", toolCallId: id, executionStarted: true, isPartial: true, expanded: false, invalidate: () => { ticks++; } }) as Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
	const print = fixture({ mode: "print" });
	for (let i = 0; i < 30; i++) {
		await expect(print.exec(undefined, undefined, `print-${i}`)).rejects.toThrow("locked");
		expect(print.renderCall({}, theme, context(`print-${i}`)).render(80)).toEqual(["# …"]);
	}
	await print.shutdown();
	let release!: (outcome: Outcome) => void;
	const live = fixture({ run: async (call) => call.args[2] === "/usr/bin/id" ? new Promise(resolve => { release = resolve; }) : ok });
	await live.command("unlock");
	const controller = new AbortController();
	const executing = live.exec(controller.signal);
	await Promise.resolve();
	const active = live.renderCall({}, theme, context("id"));
	expect(active.render(80).join(" ")).toContain("⠋");
	controller.abort();
	expect(live.renderCall({}, theme, context("id")).render(80)).toEqual(["# …"]);
	release({ ...ok, cancelled: true });
	await expect(executing).rejects.toThrow();
	const before = ticks;
	await Bun.sleep(550);
	expect(ticks).toBe(before);
	await live.shutdown();
});

test("shutdown stops an in-flight spinner and a replacement runtime cannot inherit it", async () => {
	let release!: (outcome: Outcome) => void;
	const f = fixture({ run: async (call) => call.args[2] === "/usr/bin/id" ? new Promise(resolve => { release = resolve; }) : ok });
	await f.command("unlock");
	const executing = f.exec();
	await Promise.resolve();
	let ticks = 0;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Parameters<NonNullable<ToolDefinition["renderCall"]>>[1];
	const context = { cwd: "/tmp", toolCallId: "id", executionStarted: true, isPartial: true, expanded: false, invalidate: () => { ticks++; } } as Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
	expect(f.renderCall({}, theme, context).render(80).join(" ")).toContain("⠋");
	const closing = f.shutdown();
	expect(f.renderCall({}, theme, context).render(80)).toEqual(["# …"]);
	const replacement = fixture();
	expect(replacement.renderCall({}, theme, context).render(80)).toEqual(["# …"]);
	release({ ...ok, cancelled: true });
	await Promise.allSettled([executing, closing]);
	await Bun.sleep(550);
	expect(ticks).toBe(0);
	await replacement.shutdown();
});

test("shutdown clears lightning before waiting for cleanup", async () => {
	let release!: () => void;
	let invalidations = 0;
	const f = fixture({ run: async (call) => {
		if (call.args[0] === "-k" && ++invalidations === 2) await new Promise<void>(resolve => { release = resolve; });
		return ok;
	} });
	f.startup();
	await f.command("unlock");
	const closing = f.shutdown();
	expect(f.statuses.at(-1)?.color).toBe("clear");
	release();
	await closing;
	expect(f.statuses.at(-1)?.color).toBe("clear");
});
