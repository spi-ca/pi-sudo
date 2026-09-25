/** Pi adapter: user consent and terminal ownership live here; grant policy lives in SudoAccess. */
import { Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { runProcess, sudoPath, type Runner } from "./src/process.js";
import { SudoAccess, validMinutes } from "./src/sudo.js";

function checkHost(): void {
	if (process.platform !== "linux" && process.platform !== "darwin")
		throw new Error("pi-sudo supports Linux and macOS only");
	if (process.getuid?.() === 0)
		throw new Error("Run Pi as a regular user, not root");
	sudoPath();
}

export default function sudoExtension(
	pi: ExtensionAPI,
	run: Runner = runProcess,
	hasTerminal = () =>
		Boolean(
			process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY,
		),
	ensureHost = checkHost,
): void {
	let ui: ExtensionUIContext | undefined;
	// Cleanup ownership, not authorization: only SudoAccess can admit an execution.
	let touched = false;
	// Fence UI awaits before unlock starts; SudoAccess.generation fences the later auth awaits.
	let authorizationEpoch = 0;
	let pendingUnlock = false;
	const access = new SudoAccess(
		run,
		"/usr/bin/sudo",
		undefined,
		() => {
			ui?.setStatus(
				"pi-sudo",
				access.remainingMs() > 0 ? "sudo unlocked" : undefined,
			);
		},
		(error) =>
			ui?.notify(`sudo expiry invalidation failed: ${String(error)}`, "error"),
	);

	pi.registerCommand("sudo", {
		description:
			"Explicit sudo unlock [1–15 minutes], lock, or status (interactive terminal only)",
		handler: async (raw, ctx) => {
			ui = ctx.ui;
			const parts = raw.trim().split(/\s+/);
			try {
				if (parts[0] === "status" && parts.length === 1) {
					const remaining = access.remainingMs();
					ctx.ui.notify(
						remaining
							? `sudo unlocked (${Math.ceil(remaining / 1000)}s remaining)`
							: "sudo locked",
						"info",
					);
				} else if (parts[0] === "lock" && parts.length === 1) {
					authorizationEpoch++;
					ensureHost();
					touched = true;
					await access.lock();
					touched = false;
					ctx.ui.notify(
						"sudo locked; current sudo timestamp invalidated",
						"info",
					);
				} else if (parts[0] === "unlock" && parts.length <= 2) {
					const minutes = parts.length === 2 ? validMinutes(parts[1]) : 5;
					if (ctx.mode !== "tui" || !hasTerminal()) {
						throw new Error(
							"Unlock requires Pi TUI with real terminal stdin, stdout and stderr",
						);
					}
					ensureHost();
					if (pendingUnlock) throw new Error("Sudo unlock is already pending");
					pendingUnlock = true;
					const epoch = authorizationEpoch;
					try {
						// Do not lend the terminal to sudo while the agent is still producing output.
						await ctx.waitForIdle();
						if (epoch !== authorizationEpoch)
							throw new Error("Unlock was revoked");
						const approved = await ctx.ui.confirm(
							"Temporarily allow administrator commands?",
							`For up to ${minutes} minute(s), the model may run ANY command allowed by your sudo policy, without per-command approval. Untrusted project text can influence the model. Lock cannot undo changes or guarantee stopping root descendants. The sudo cache may be shared with this terminal. Continue?`,
						);
						if (!approved) return;
						if (epoch !== authorizationEpoch)
							throw new Error("Unlock was revoked");
						touched = true;
						// No password enters Pi input dialogs, tools, pipes, transcripts or model context.
						const error = await ctx.ui.custom<unknown>(
							(tui, _theme, _keys, done) => {
								void (async () => {
									let stopped = false;
									let failure: unknown;
									try {
										tui.stop();
										stopped = true;
										await access.unlock(minutes, true);
									} catch (error) {
										failure = error;
									} finally {
										try {
											if (stopped) {
												tui.start();
												tui.requestRender(true);
											}
										} catch (error) {
											failure = error;
											// If TUI restoration fails, revoke access regardless of auth result.
											try {
												await access.lock();
											} catch {
												/* best effort; report restoration error */
											}
										} finally {
											// Always settle the custom screen, including a failed terminal restore.
											done(failure);
										}
									}
								})();
								return { render: () => [], invalidate: () => {} };
							},
						);
						if (error) throw error;
						if (access.remainingMs() > 0)
							ctx.ui.notify(
								"sudo unlocked (no automatic extension renewal)",
								"info",
							);
					} finally {
						pendingUnlock = false;
					}
				} else {
					throw new Error(
						"Usage: /sudo unlock [minutes] | /sudo lock | /sudo status",
					);
				}
			} catch (error) {
				ctx.ui.notify(String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "sudo_exec",
		label: "Sudo Exec",
		description:
			"Execute one absolute executable with argv under an explicitly user-unlocked sudo window. No shell, no password parameters. 60s timeout; nonzero result revokes access.",
		parameters: Type.Object({
			executable: Type.String({
				description: "Absolute path to executable; never a shell command",
			}),
			args: Type.Array(Type.String(), {
				description: "Argument vector (not a shell string)",
			}),
			cwd: Type.Optional(
				Type.String({ description: "Absolute working directory" }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			ui = ctx.ui;
			ensureHost();
			if (!touched)
				throw new Error("sudo locked; user must run /sudo unlock in TUI");
			const result = await access.exec(
				params.executable,
				params.args,
				params.cwd ?? ctx.cwd,
				signal,
			);
			const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
			const text = `exit=${result.code}, cancelled=${result.cancelled}, timedOut=${result.timedOut}, truncated=${result.truncated}\n${output}`;
			if (result.code !== 0 || result.cancelled || result.timedOut)
				throw new Error(text);
			return {
				content: [{ type: "text", text }],
				details: {
					code: result.code,
					cancelled: result.cancelled,
					timedOut: result.timedOut,
					truncated: result.truncated,
				},
			};
		},
	});

	// Pi 0.87.1 emits shutdown for session replacement and reload as well as exit.
	// No grant is persisted or carried into a replacement extension runtime.
	pi.on("session_shutdown", async (_event, ctx) => {
		authorizationEpoch++;
		ui = ctx.ui;
		if (touched) {
			try {
				await access.lock();
			} catch (error) {
				ctx.ui.notify(`sudo lock failed: ${String(error)}`, "error");
			}
		}
		touched = false;
		ctx.ui.setStatus("pi-sudo", undefined);
		ui = undefined;
	});
}
