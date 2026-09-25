/** Pi adapter: user consent and terminal ownership live here; grant policy lives in SudoAccess. */
import { Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { trustedAskpass } from "./src/askpass.js";
import { boundedError, boundedText, formatOutcome } from "./src/output.js";
import { runProcess, sudoPath, type Runner } from "./src/process.js";
import { SudoAccess, validMinutes, type Clock } from "./src/sudo.js";
import { createCallRenderer, renderResult } from "./src/render.js";

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
	statusTimer: Pick<Clock, "setTimeout" | "clearTimeout"> = globalThis,
	accessClock?: Clock,
): void {
	const callRenderer = createCallRenderer();
	let ui: ExtensionUIContext | undefined;
	let closed = false;
	let cacheWarning = false;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	const stopRefresh = () => {
		if (refreshTimer) statusTimer.clearTimeout(refreshTimer);
		refreshTimer = undefined;
	};
	const cleanupFailed = (error: unknown) =>
		String(error).includes("sudo -k cleanup failed; credential cache may remain valid") ||
		String(error).includes("sudo -k failed; credential cache may remain valid");
	function updateStatus(): void {
		stopRefresh();
		if (closed || !ui) return;
		// remainingMs may synchronously revoke an expired grant and call back here.
		const remaining = access.remainingMs();
		if (closed || !ui) return;
		let label: string | undefined;
		let color: "warning" | "error" = "warning";
		if (remaining > 0) {
			const seconds = Math.ceil(remaining / 1000);
			label = `⚡ sudo ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
			color = "warning";
			refreshTimer = statusTimer.setTimeout(updateStatus, Math.min(1000, remaining));
			refreshTimer.unref?.();
		} else if (cacheWarning) {
			label = "⚠️ sudo";
			color = "error";
		} else if (pendingUnlock && pendingEpoch === authorizationEpoch) {
			label = "⏳ sudo";
			color = "warning";
		}
		if (label === undefined) {
			ui.setStatus("pi-sudo", undefined);
			return;
		}
		const displayLabel = remaining > 0 && remaining <= 30_000 ? ui.theme.bold(label) : label;
		ui.setStatus("pi-sudo", ui.theme.fg(color, displayLabel));
	}
	let pendingEpoch = -1;
	// Cleanup ownership, not authorization: only SudoAccess can admit an execution.
	let touched = false;
	// Fence UI awaits before unlock starts; SudoAccess.generation fences the later auth awaits.
	let authorizationEpoch = 0;
	let pendingUnlock = false;
	// Recheck the sudo binary for every child, including late cleanup after a host failure.
	const checkedRun: Runner = async (invocation) => {
		const invalidating = invocation.args[0] === "-k";
		try {
			ensureHost();
			const result = await run(invocation);
			if (invalidating) {
				cacheWarning = result.code !== 0 || result.cancelled || result.timedOut || Boolean(result.terminationUnconfirmed);
				updateStatus();
			}
			return result;
		} catch (error) {
			if (invalidating) {
				cacheWarning = true;
				updateStatus();
			}
			throw error;
		}
	};
	const access = new SudoAccess(
		checkedRun,
		"/usr/bin/sudo",
		accessClock,
		updateStatus,
		(error) => {
			cacheWarning = true;
			updateStatus();
			if (!closed) ui?.notify(
				boundedError(`sudo expiry invalidation failed: ${String(error)}`),
				"error",
			);
		},
	);

	pi.on("session_start", (_event, ctx) => {
		closed = false;
		ui = ctx.ui;
		updateStatus();
	});

	pi.registerCommand("sudo", {
		description:
			"Explicit sudo unlock [1–15 minutes], lock, or status (interactive terminal only)",
		handler: async (raw, ctx) => {
			if (!closed) ui = ctx.ui;
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
					updateStatus();
					try {
						await access.lock();
					} catch (error) {
						cacheWarning = true;
						throw error;
					}
					cacheWarning = false;
					updateStatus();
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
					const minutesArg = parts[1] === "--askpass" ? undefined : parts[1];
					const minutes = minutesArg ? validMinutes(minutesArg) : 5;
					if (ctx.mode !== "tui" || !hasTerminal()) {
						throw new Error(
							"Unlock requires Pi TUI with real terminal stdin, stdout and stderr",
						);
					}
					ensureHost();
					const selectedAskpass = askpassEnvironment();
					if (parts.includes("--askpass") && selectedAskpass === undefined)
						throw new Error("--askpass requires SUDO_ASKPASS");
					const helper = selectedAskpass === undefined ? undefined : resolveAskpass(selectedAskpass);
					if (pendingUnlock) throw new Error("Sudo unlock is already pending");
					pendingUnlock = true;
					const epoch = authorizationEpoch;
					pendingEpoch = epoch;
					updateStatus();
					try {
						// Do not lend the terminal to sudo while the agent is still producing output.
						await ctx.waitForIdle();
						if (epoch !== authorizationEpoch)
							throw new Error("Unlock was revoked");
						const approved = await ctx.ui.confirm(
							"Temporarily allow administrator commands?",
							[
								`Duration: up to ${minutes} minute(s). Mode: ${helper ? `OS askpass (${helper})` : "terminal"}.`,
								"",
								"• The model may run ANY command allowed by your sudo policy without per-command approval. Use sudo_exec, not ordinary bash.",
								"• Untrusted project text can influence the model.",
								"• Lock cannot undo changes or guarantee stopping root descendants.",
								"• The sudo cache may be shared with this terminal.",
								"",
								"Continue?",
							].join("\n"),
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
								helper
									? () => {
											const selected = askpassEnvironment();
											if (selected === undefined)
												throw new Error("SUDO_ASKPASS helper changed after confirmation");
											const current = resolveAskpass(selected);
											if (current !== helper)
												throw new Error(
													"SUDO_ASKPASS helper changed after confirmation",
												);
											return current;
										}
									: undefined,
							);
						if (helper) {
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
												} catch (cleanupError) {
													failure = new Error(`${String(failure)}; sudo cache cleanup failed: ${String(cleanupError)}`);
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
						if (access.remainingMs() > 0) {
							cacheWarning = false;
							updateStatus();
							ctx.ui.notify(
								"sudo unlocked: use sudo_exec, not ordinary bash; no automatic renewal",
								"info",
							);
						}
					} finally {
						pendingUnlock = false;
						updateStatus();
					}
				} else {
					throw new Error(
						"Usage: /sudo unlock [minutes] | /sudo lock | /sudo status",
					);
				}
			} catch (error) {
				if (cleanupFailed(error)) cacheWarning = true;
				updateStatus();
				ctx.ui.notify(boundedError(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "sudo_exec",
		label: "#",
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
		renderCall: callRenderer.renderCall,
		renderResult,
		async execute(_id, params, signal, onUpdate, ctx) {
			// Pi marks the TUI row started before invoking execute; its first update
			// renders after admission, while export/print never admit a spinner.
			if (!closed && ctx.mode === "tui" && !signal?.aborted) callRenderer.start(_id);
			const onAbort = () => callRenderer.stop(_id);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			try {
				if (!closed) ui = ctx.ui;
				try {
					ensureHost();
				} catch (error) {
					try {
						await access.lock();
					} catch {
						cacheWarning = true;
						updateStatus();
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
				let lastDisplayOutput: string | undefined;
				try {
					onUpdate?.({
						content: [{ type: "text", text: "Checking access and running command…" }],
						details: undefined,
					});
					result = await access.exec(
						params.executable,
						params.args,
						params.cwd ?? ctx.cwd,
						signal,
						onUpdate ? ({ stdout, stderr, truncated, displayOutput, displayTruncated }) => {
							lastDisplayOutput = displayOutput;
							const output = displayOutput ?? [stdout, stderr].filter(Boolean).join("\n");
							const bounded = boundedText([output]);
							onUpdate({
								content: [{ type: "text", text: bounded.text }],
								details: { streaming: true, truncated: truncated || bounded.truncated, displayOutput, displayTruncated },
							});
						} : undefined,
					);
				} catch (error) {
					if (cleanupFailed(error)) cacheWarning = true;
					updateStatus();
					// Spawn/transport failures have no Outcome or Pi details. Preserve
					// the last streamed ordered tail after the error diagnostic.
					const message = lastDisplayOutput
						? `${String(error)}\n${lastDisplayOutput}`
						: error;
					throw new Error(boundedError(message));
				}
				if (result.cleanupWarning) cacheWarning = true;
				updateStatus();
				if (result.code !== 0 || result.cancelled || result.timedOut) {
					// Pi drops details for thrown tools. Use the ordered tail in the
					// bounded error text so completed error cards retain the last output.
					const failure = result.displayOutput === undefined ? result : {
						...result,
						stdout: result.displayOutput,
						stderr: "",
						truncated: result.truncated || result.displayTruncated === true,
					};
					throw new Error(formatOutcome(failure).text);
				}
				const { text, truncated } = formatOutcome(result);
				return {
					content: [{ type: "text", text }],
					details: {
						code: result.code,
						cancelled: result.cancelled,
						timedOut: result.timedOut,
						truncated,
						displayOutput: result.displayOutput,
						displayTruncated: result.displayTruncated,
					},
				};
			} finally {
				signal?.removeEventListener("abort", onAbort);
				callRenderer.stop(_id);
			}
		},
	});

	// Pi 0.87.1 emits shutdown for session replacement and reload as well as exit.
	// No grant is persisted or carried into a replacement extension runtime.
	pi.on("session_shutdown", async (_event, ctx) => {
		authorizationEpoch++;
		closed = true;
		callRenderer.stopAll();
		ctx.ui.setStatus("pi-sudo", undefined);
		stopRefresh();
		ui = undefined;
		if (touched) {
			try {
				await access.lock();
			} catch (error) {
				cacheWarning = true;
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
