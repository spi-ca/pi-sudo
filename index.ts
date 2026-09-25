/** Pi adapter: user consent and terminal ownership live here; grant policy lives in SudoAccess. */
import { Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { trustedAskpass } from "./src/askpass.js";
import { boundedError, formatOutcome } from "./src/output.js";
import { runProcess, sudoPath, type Runner } from "./src/process.js";
import { SudoAccess, validMinutes } from "./src/sudo.js";
import { renderCall, renderResult } from "./src/render.js";

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
	askpassEnvironment = () => process.env.SUDO_ASKPASS,
	resolveAskpass = trustedAskpass,
): void {
	let ui: ExtensionUIContext | undefined;
	// Cleanup ownership, not authorization: only SudoAccess can admit an execution.
	let touched = false;
	// Fence UI awaits before unlock starts; SudoAccess.generation fences the later auth awaits.
	let authorizationEpoch = 0;
	let pendingUnlock = false;
	// Recheck the sudo binary for every child, including late cleanup after a host failure.
	const checkedRun: Runner = (invocation) => {
		ensureHost();
		return run(invocation);
	};
	const access = new SudoAccess(
		checkedRun,
		"/usr/bin/sudo",
		undefined,
		() => {
			ui?.setStatus(
				"pi-sudo",
				access.remainingMs() > 0 ? "sudo unlocked" : undefined,
			);
		},
		(error) =>
			ui?.notify(
				boundedError(`sudo expiry invalidation failed: ${String(error)}`),
				"error",
			),
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
					touched = true;
					await access.lock();
					touched = false;
					ctx.ui.notify(
						"sudo locked; current sudo timestamp invalidated",
						"info",
					);
				} else if (
					parts[0] === "unlock" &&
					parts.length <= 3 &&
					(parts.length < 3 ||
						(parts[2] === "--askpass" && parts[1] !== "--askpass"))
				) {
					const askpass = parts.includes("--askpass");
					const minutesArg = parts[1] === "--askpass" ? undefined : parts[1];
					const minutes = minutesArg ? validMinutes(minutesArg) : 5;
					if (ctx.mode !== "tui" || !hasTerminal()) {
						throw new Error(
							"Unlock requires Pi TUI with real terminal stdin, stdout and stderr",
						);
					}
					ensureHost();
					const helper = askpass
						? resolveAskpass(askpassEnvironment())
						: undefined;
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
							`Mode: ${askpass ? `OS askpass (${helper})` : "terminal"}. For up to ${minutes} minute(s), the model may run ANY command allowed by your sudo policy, without per-command approval. Untrusted project text can influence the model. Lock cannot undo changes or guarantee stopping root descendants. The sudo cache may be shared with this terminal. Continue?`,
						);
						if (!approved) return;
						if (epoch !== authorizationEpoch)
							throw new Error("Unlock was revoked");
						touched = true;
						// No password enters Pi input dialogs, tools, pipes, transcripts or model context.
						const authenticate = () =>
							access.unlock(
								minutes,
								true,
								askpass
									? () => {
											const current = resolveAskpass(askpassEnvironment());
											if (current !== helper)
												throw new Error(
													"SUDO_ASKPASS helper changed after confirmation",
												);
											return current;
										}
									: undefined,
							);
						if (askpass) {
							await authenticate();
						} else {
							const error = await ctx.ui.custom<unknown>(
								(tui, _theme, _keys, done) => {
									void (async () => {
										let stopped = false;
										let failure: unknown;
										try {
											tui.stop();
											stopped = true;
											await authenticate();
										} catch (error) {
											failure = error;
										} finally {
											try {
												if (stopped) {
													tui.start();
													tui.requestRender(true);
												}
											} catch (error) {
												failure = failure
													? new Error(
															`${String(failure)}; TUI restoration failed: ${String(error)}`,
														)
													: error;
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
						}
						if (access.remainingMs() > 0)
							ctx.ui.notify(
								"sudo unlocked: use sudo_exec, not ordinary bash; expiry and /sudo lock remain separate from OS cache (no automatic renewal)",
								"info",
							);
					} finally {
						pendingUnlock = false;
					}
				} else {
					throw new Error(
						"Usage: /sudo unlock [minutes] [--askpass] | /sudo lock | /sudo status",
					);
				}
			} catch (error) {
				ctx.ui.notify(boundedError(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "sudo_exec",
		label: "Sudo Exec",
		description:
			"Execute one absolute executable with argv under an explicitly user-unlocked sudo window. Use sudo_exec, not ordinary bash: the grant and OS cache are separate. No shell, no password parameters. 60s timeout; nonzero result revokes access.",
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
		renderCall,
		renderResult,
		async execute(_id, params, signal, onUpdate, ctx) {
			ui = ctx.ui;
			try {
				ensureHost();
			} catch (error) {
				try {
					await access.lock();
				} catch {
					throw new Error(
						boundedError(
							`sudo -k cleanup failed; credential cache may remain valid; original: ${String(error)}`,
						),
					);
				}
				throw new Error(boundedError(error));
			}
			if (!touched)
				throw new Error("sudo locked; user must run /sudo unlock in TUI");
			let result;
			try {
				onUpdate?.({
					content: [{ type: "text", text: "권한 확인 및 명령 실행 중…" }],
					details: undefined,
				});
				result = await access.exec(
					params.executable,
					params.args,
					params.cwd ?? ctx.cwd,
					signal,
				);
			} catch (error) {
				throw new Error(boundedError(error));
			}
			const { text, truncated } = formatOutcome(result);
			if (result.code !== 0 || result.cancelled || result.timedOut)
				throw new Error(text);
			return {
				content: [{ type: "text", text }],
				details: {
					code: result.code,
					cancelled: result.cancelled,
					timedOut: result.timedOut,
					truncated,
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
				ctx.ui.notify(
					boundedError(`sudo lock failed: ${String(error)}`),
					"error",
				);
			}
		}
		touched = false;
		ctx.ui.setStatus("pi-sudo", undefined);
		ui = undefined;
	});
}
