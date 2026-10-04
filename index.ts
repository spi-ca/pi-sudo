/** Pi adapter: user consent and terminal ownership live here; grant policy lives in SudoAccess. */
import { Type } from "@earendil-works/pi-ai";
import { Container, truncateToWidth } from "@earendil-works/pi-tui";
import { createQuestionnaireComponent, normalizeQuestions, type QuestionnaireResult } from "pi-ask-user/ui";
import type { TUI, TuiMainScreenRenderState } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { trustedAskpass } from "./src/askpass.js";
import { boundedError, boundedText, formatOutcome } from "./src/output.js";
import { runProcess, sudoPath, type Runner } from "./src/process.js";
import { SudoAccess, validMinutes, type Clock, type ReauthTicket } from "./src/sudo.js";
import { createCallRenderer, renderResult } from "./src/render.js";

const approvalWarnings = [
	"• The model can run any sudo-policy command without asking again. Use sudo_exec, not bash.",
	"• Untrusted text may influence the model.",
	"• Lock cannot undo changes or guarantee root descendants stop.",
	"• This terminal's sudo cache may be shared.",
];

async function approveUnlock(ui: ExtensionUIContext, minutes: number, mode: string, reauth = false, signal?: AbortSignal): Promise<boolean> {
	const prompt = reauth
		? `Reauthenticate sudo_exec for the remaining window (at most ${minutes} ${minutes === 1 ? "minute" : "minutes"}; no extension)?`
		: `Allow sudo_exec to run as administrator for up to ${minutes} ${minutes === 1 ? "minute" : "minutes"}?`;
	const authentication = mode === "terminal" ? "Authenticate in this terminal" : `Authenticate with ${mode}`;
	// The askpass path can be arbitrarily long. Reject, rather than let the
	// questionnaire silently shorten a disclosure or drop a risk warning.
	const disclosure = [prompt, authentication, ...approvalWarnings].join("\n");
	const questions = normalizeQuestions({ questions: [{
		id: "sudo", prompt: disclosure,
		options: [{ value: "no", label: "NO (default)" }, { value: "yes", label: "YES" }],
		defaultValues: ["no"], allowOther: false, optional: false,
		multiSelect: false, requireReview: false,
	}] });
	if (typeof questions === "string" || questions.length !== 1 || questions[0]?.prompt !== disclosure ||
		questions[0]?.id !== "sudo" || questions[0]?.options.length !== 2 ||
		questions[0]?.options[0]?.value !== "no" || questions[0]?.options[0]?.label !== "NO (default)" ||
		questions[0]?.options[1]?.value !== "yes" || questions[0]?.options[1]?.label !== "YES" ||
		questions[0]?.defaultValues.length !== 1 || questions[0]?.defaultValues[0] !== "no" ||
		questions[0]?.allowOther || questions[0]?.optional || questions[0]?.multiSelect || questions[0]?.requireReview)
		throw new Error("Sudo consent disclosure cannot be shown intact");
	const cancelled: QuestionnaireResult = { cancelled: true, questions, answers: [] };
	let dismiss: (() => void) | undefined;
	const onAbort = () => dismiss?.();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const result = await ui.custom<QuestionnaireResult>((tui, theme, keybindings, done) => {
			dismiss = () => done(cancelled);
			if (signal?.aborted) dismiss();
			let shown: { width: number; columns: number; rows: number; lines: number } | undefined;
			let component: ReturnType<typeof createQuestionnaireComponent>;
			const fullFrame = (width: number) => component.render(width);
			const fits = (width: number, lines: number) =>
				width >= 32 && width === tui.terminal.columns &&
				lines <= Math.max(0, tui.terminal.rows - 5);
			const contains = (child: TUI["children"][number]): boolean =>
				child === wrapper || (child instanceof Container && child.children.some(contains));
			const canSubmit = (answer: QuestionnaireResult): boolean => {
				const selected = answer.answers.find(item => item.id === "sudo");
				if (selected?.kind === "single" && selected.value === "no") return true;
				if (selected?.kind !== "single" || selected.value !== "yes") return false;
				const width = tui.terminal.columns;
				const lines = fullFrame(width).length;
				if (shown && shown.width === width && shown.columns === width &&
					shown.rows === tui.terminal.rows && shown.lines === lines && fits(width, lines)) {
					// Pi 0.87.1 mounts the transcript first, then fixed dock components.
					// Reserve every dock sibling at full height and one transcript row.
					const owner = tui.children.find(contains);
					const siblings = tui.children.slice(1).filter(child => child !== owner);
					const available = tui.terminal.rows - 1 - siblings.reduce((rows, child) => rows + child.render(width).length, 0);
					if (owner && owner !== tui.children[0] && lines <= available) return true;
				}
				ui.notify("Sudo consent is clipped; enlarge the terminal or reduce widgets, then confirm again. Esc cancels.", "warning");
				return false;
			};
			component = createQuestionnaireComponent({ questions, tui, theme, keybindings, done, canSubmit });
			const wrapper = {
				get focused() { return component.focused; },
				set focused(value: boolean) { component.focused = value; },
				render(width: number) {
					const lines = fullFrame(width);
					shown = fits(width, lines.length)
						? { width, columns: tui.terminal.columns, rows: tui.terminal.rows, lines: lines.length }
						: undefined;
					return shown ? lines : [truncateToWidth(theme.fg("warning", "Resize / Esc to cancel"), Math.max(1, width), "")];
				},
				invalidate() { shown = undefined; component.invalidate(); },
				handleInput(data: string) { component.handleInput(data); },
				handleMouse(event: Parameters<typeof component.handleMouse>[0]) { return component.handleMouse(event); },
			};
			return wrapper;
		});
		return !signal?.aborted && !result.cancelled && result.answers.some(answer =>
			answer.id === "sudo" && answer.kind === "single" && answer.value === "yes");
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

// waitForIdle has no cancellation API in Pi 0.87.1. Release this command's
// ownership on revocation without waiting for a potentially long agent turn.
async function waitForIdleOrRevoked(waitForIdle: () => Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw new Error("Unlock was revoked");
	let onAbort!: () => void;
	const revoked = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new Error("Unlock was revoked"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([waitForIdle(), revoked]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

// sudo inherits the real TTY. In regular mode, stop() moves below the footer;
// after sudo writes, old differential-render coordinates cannot be trusted.
function checkTerminalAuthHandoff(tui: TUI): void {
	if (tui.mode === "regular") {
		if (typeof (tui as TUI & { captureRenderState?: unknown }).captureRenderState !== "function" ||
			typeof (tui as TUI & { restoreRenderState?: unknown }).restoreRenderState !== "function")
			throw new Error("Regular TUI does not support safe terminal authentication handoff");
	} else if (tui.mode !== "fullscreen") {
		throw new Error("Unsupported TUI mode for terminal authentication");
	}
}

function terminalAuthHandoff(tui: TUI): void {
	if (tui.mode === "regular") tui.stop();
	else tui.stop({ preserveScreen: true });
}

function resumeTerminalAuth(tui: TUI): void {
	if (tui.mode === "regular") {
		const main = tui as TUI & {
			captureRenderState(): TuiMainScreenRenderState;
			restoreRenderState(state: TuiMainScreenRenderState): void;
		};
		// Cancellation can leave sudo's prompt mid-line. Re-anchor on a fresh line.
		tui.terminal.write("\r\n");
		main.restoreRenderState({
			...main.captureRenderState(),
			previousLines: [], previousWidth: 0, previousHeight: 0,
			cursorRow: 0, hardwareCursorRow: 0, maxLinesRendered: 0, previousViewportTop: 0,
		});
	}
	tui.start();
	// The host can request a render while authentication has TUI stopped.
	// Pi 0.87.1 leaves that request pending, so start() alone may never schedule
	// another frame. Flush without force: force would clear regular scrollback.
	tui.renderNow();
}

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
		} else if (pending && pending.epoch === authorizationEpoch) {
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
	let pending: { epoch: number; abort: AbortController } | undefined;
	// Cleanup ownership, not authorization: only SudoAccess can admit an execution.
	let touched = false;
	// Fence UI awaits before unlock starts; SudoAccess.generation fences the later auth awaits.
	let authorizationEpoch = 0;
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
			"Explicit sudo unlock [1–180 minutes], reauth, lock, or status (interactive terminal only)",
		handler: async (raw, ctx) => {
			if (!closed) ui = ctx.ui;
			const parts = raw.trim().split(/\s+/);
			try {
				if (parts[0] === "status" && parts.length === 1) {
					const remaining = access.remainingMs();
					ctx.ui.notify(
						remaining
							? `sudo_exec: up to ${Math.ceil(remaining / 1000)}s left; OS sudo credentials may expire sooner (ordinary bash is not elevated)`
							: "sudo locked",
						"info",
					);
				} else if (parts[0] === "lock" && parts.length === 1) {
					authorizationEpoch++;
					pending?.abort.abort();
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
					(parts[0] === "reauth" && parts.length === 1) ||
					(parts[0] === "unlock" && parts.length <= 3 &&
						(parts.length < 3 || (parts[2] === "--askpass" && parts[1] !== "--askpass")))
				) {
					const reauth = parts[0] === "reauth";
					const minutesArg = parts[1] === "--askpass" ? undefined : parts[1];
					const minutes = reauth ? 0 : minutesArg ? validMinutes(minutesArg) : 5;
					if (ctx.mode !== "tui" || !hasTerminal()) {
						if (reauth && access.remainingMs() > 0) await access.lock();
						throw new Error(
							"Unlock requires Pi TUI with real terminal stdin, stdout and stderr",
						);
					}
					try { ensureHost(); }
					catch (error) {
						if (reauth && access.remainingMs() > 0) await access.lock();
						throw error;
					}
					if (pending) throw new Error("Sudo unlock is already pending");
					if (!reauth && access.remainingMs() > 0) throw new Error("Already unlocked; lock first (no automatic renewal)");
					// SudoAccess captures both deadlines and revokes before any UI await.
					const ticket: ReauthTicket | undefined = reauth ? access.beginReauth() : undefined;
					const attempt = { epoch: authorizationEpoch, abort: new AbortController() };
					pending = attempt;
					const epoch = attempt.epoch;
					updateStatus();
					try {
						const selectedAskpass = askpassEnvironment();
						if (parts.includes("--askpass") && selectedAskpass === undefined)
							throw new Error("--askpass requires SUDO_ASKPASS");
						const helper = selectedAskpass === undefined ? undefined : resolveAskpass(selectedAskpass);
						if (epoch !== authorizationEpoch || closed)
							throw new Error("Unlock was revoked");
						const displayHelper = helper?.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) =>
							`\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
						);
						const approved = await approveUnlock(
							ctx.ui, reauth ? Math.ceil(access.reauthRemainingMs(ticket!) / 60_000) : minutes,
							displayHelper ? `OS askpass (${displayHelper})` : "terminal", reauth, attempt.abort.signal,
						);
						if (!approved) return;
						// Consent is shown during the agent turn, but sudo must not take
						// the terminal (or start askpass) until the turn has settled.
						await waitForIdleOrRevoked(() => ctx.waitForIdle(), attempt.abort.signal);
						if (epoch !== authorizationEpoch || closed || attempt.abort.signal.aborted)
							throw new Error("Unlock was revoked");
						// No password enters Pi input dialogs, tools, pipes, transcripts or model context.
						const authenticate = () => {
							touched = true;
							const authHelper = helper
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
									: undefined;
							return ticket ? access.reauth(ticket, true, authHelper) : access.unlock(minutes, true, authHelper);
						};
						if (helper) {
							await authenticate();
						} else {
							const error = await ctx.ui.custom<unknown>(
								(tui, _theme, _keys, done) => {
									void (async () => {
										let attemptedStop = false;
										let cancelled = false;
										let cancellation: Promise<void> | undefined;
										let failure: unknown;
										const onInterrupt = () => {
											if (cancelled) return;
											cancelled = true;
											// Revoke immediately and abort active auth/probe, including late success.
											cancellation = access.lock();
											void cancellation.catch(() => {});
										};
										try {
											checkTerminalAuthHandoff(tui);
											process.on("SIGINT", onInterrupt);
											// A failed stop can leave input disabled; still attempt restoration.
											attemptedStop = true;
											terminalAuthHandoff(tui);
											if (cancelled) throw new Error("Unlock cancelled");
											await authenticate();
											if (cancelled) throw new Error("Unlock cancelled");
										} catch (error) {
											failure = error;
										} finally {
											try {
												if (attemptedStop) resumeTerminalAuth(tui);
											} catch (error) {
												failure = failure
													? new Error(`${String(failure)}; TUI restoration failed: ${String(error)}`)
													: error;
												try { await access.lock(); }
												catch (cleanupError) { failure = new Error(`${String(failure)}; sudo cache cleanup failed: ${String(cleanupError)}`); }
											} finally {
												try {
													if (cancelled) {
														failure ??= new Error("Unlock cancelled");
														try { await cancellation; }
														catch (cleanupError) { failure = new Error(`${String(failure)}; sudo cache cleanup failed: ${String(cleanupError)}`); }
													}
												} finally {
													process.removeListener("SIGINT", onInterrupt);
													done(failure);
												}
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
								"sudo_exec is ready. /sudo status shows the remaining window; OS sudo credentials may expire sooner. /sudo lock ends access.",
								"info",
							);
						}
					} finally {
						try {
							if (ticket) await access.abandonReauth(ticket);
						} catch (error) {
							cacheWarning = true;
							throw error;
						} finally {
							if (pending === attempt) pending = undefined;
							updateStatus();
						}
					}
				} else {
					throw new Error(
						"Usage: /sudo unlock [minutes] | /sudo reauth | /sudo lock | /sudo status",
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
		exposure: "model-only",
		description:
			"Execute one absolute executable with argv under an explicitly user-unlocked sudo window. Use sudo_exec, not ordinary bash: the grant and OS cache are separate. No shell, no password parameters. 60s timeout; a completed nonzero exit is a tool error but does not revoke the grant; cancellation, timeout and transport failure do.",
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
				const isError = result.code !== 0 || result.cancelled || result.timedOut;
				const { text, truncated } = formatOutcome(result);
				return {
					...(isError ? { isError: true } : {}),
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
		pending?.abort.abort();
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
