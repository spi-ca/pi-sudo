/** Direct-child transport: terminal handoff, bounded capture and best-effort cancellation. */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";

export type Invocation = {
	executable: string;
	args: string[];
	cwd?: string;
	/** Authentication only: inherit real terminal FDs; never capture password input. */
	interactive?: boolean;
	/** Authentication only: sudo invokes this helper; Pi never invokes it directly. */
	askpass?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Execution only: bounded snapshots; never attach to auth, probe or cleanup. */
	onOutput?: (output: Pick<Outcome, "stdout" | "stderr" | "truncated">) => void;
};
export type Outcome = {
	code: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	cancelled: boolean;
	timedOut: boolean;
	/** The watchdog settled without observing direct-child exit, not a descendant census. */
	terminationUnconfirmed?: boolean;
	cleanupWarning?: string;
};
export type Runner = (invocation: Invocation) => Promise<Outcome>;

export function sudoPath(): string {
	const path = "/usr/bin/sudo";
	const stat = statSync(path);
	if (
		!stat.isFile() ||
		stat.uid !== 0 ||
		(stat.mode & 0o111) === 0 ||
		(stat.mode & 0o022) !== 0
	) {
		throw new Error(
			"/usr/bin/sudo must be a root-owned executable, not group/world writable",
		);
	}
	return path;
}

const OUTPUT_LIMIT = 32 * 1024;
const UPDATE_INTERVAL_MS = 150;

export const runProcess: Runner = (invocation) =>
	new Promise((resolve, reject) => {
		if (invocation.signal?.aborted) {
			reject(new Error("Operation cancelled"));
			return;
		}
		// Keep sudo's parent and controlling-terminal context consistent with authentication.
		// A shell wrapper or detached session could select a different sudo timestamp record.
		// Never leak ambient askpass into probe, execution or invalidation children.
		const { SUDO_ASKPASS: _ambientAskpass, ...environment } = process.env;
		const child = spawn(invocation.executable, invocation.args, {
			env: invocation.askpass
				? { ...environment, SUDO_ASKPASS: invocation.askpass }
				: environment,
			cwd: invocation.cwd,
			shell: false,
			detached: false,
			stdio: invocation.askpass
				? "ignore"
				: invocation.interactive
					? "inherit"
					: ["ignore", "pipe", "pipe"],
		});
		// Allocate only on first data; avoid copying the retained prefix per chunk.
		let stdout: Buffer | undefined;
		let stderr: Buffer | undefined;
		let stdoutLength = 0;
		let stderrLength = 0;
		let truncated = false;
		let updateTimer: ReturnType<typeof setTimeout> | undefined;
		let cancelled = false;
		let timedOut = false;
		// Promise settlement, direct-child exit, and pipe closure are different events.
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		const scheduleUpdate = () => {
			if (settled || cancelled || !invocation.onOutput || updateTimer) return;
			updateTimer = setTimeout(() => {
				updateTimer = undefined;
				if (settled || cancelled) return;
				try {
					invocation.onOutput?.({
						stdout: stdout?.subarray(0, stdoutLength).toString("utf8") ?? "",
						stderr: stderr?.subarray(0, stderrLength).toString("utf8") ?? "",
						truncated,
					});
				} catch {
					// UI updates must not change execution or revocation.
				}
			}, UPDATE_INTERVAL_MS);
			updateTimer.unref?.();
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			if (settled) return;
			const length = Math.min(chunk.length, OUTPUT_LIMIT - stdoutLength);
			if (length) {
				stdout ??= Buffer.allocUnsafe(OUTPUT_LIMIT);
				chunk.copy(stdout, stdoutLength, 0, length);
				stdoutLength += length;
			}
			const wasTruncated = truncated;
			if (length < chunk.length) truncated = true;
			if (length || !wasTruncated && truncated) scheduleUpdate();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (settled) return;
			const length = Math.min(chunk.length, OUTPUT_LIMIT - stderrLength);
			if (length) {
				stderr ??= Buffer.allocUnsafe(OUTPUT_LIMIT);
				chunk.copy(stderr, stderrLength, 0, length);
				stderrLength += length;
			}
			const wasTruncated = truncated;
			if (length < chunk.length) truncated = true;
			if (length || !wasTruncated && truncated) scheduleUpdate();
		});
		const finish = () => {
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (settleTimer) clearTimeout(settleTimer);
			if (updateTimer) clearTimeout(updateTimer);
			updateTimer = undefined;
			invocation.signal?.removeEventListener("abort", onAbort);
			child.stdout?.destroy();
			child.stderr?.destroy();
		};
		const complete = (code: number | null, terminationUnconfirmed = false) => {
			if (settled) return;
			finish();
			resolve({
				code,
				stdout: stdout?.subarray(0, stdoutLength).toString("utf8") ?? "",
				stderr: stderr?.subarray(0, stderrLength).toString("utf8") ?? "",
				truncated,
				cancelled,
				timedOut,
				terminationUnconfirmed,
			});
		};
		const sendSignal = (signal: NodeJS.Signals) => {
			try {
				child.kill(signal);
			} catch {
				/* A privileged process may reject signals. The watchdog still settles. */
			}
		};
		const terminate = () => {
			if (settled || cancelled) return;
			cancelled = true;
			if (updateTimer) clearTimeout(updateTimer);
			updateTimer = undefined;
			// The direct process may have already exited while a descendant holds the pipes.
			if (exited) {
				complete(exitCode);
				return;
			}
			sendSignal("SIGTERM");
			killTimer = setTimeout(() => {
				if (!settled) sendSignal("SIGKILL");
			}, 1000);
			// Signal delivery can fail for privileged processes. Bound our wait without
			// pretending the child died; SudoAccess poisons future grants on this outcome.
			settleTimer = setTimeout(() => {
				if (!settled) {
					child.unref();
					complete(exitCode, !exited);
				}
			}, 1500);
			killTimer.unref?.();
			settleTimer.unref?.();
		};
		const onAbort = () => terminate();
		invocation.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, invocation.timeoutMs);
		timer.unref?.();
		child.on("error", (error) => {
			if (settled) return;
			// kill() can emit an error without the child exiting. Keep the watchdog alive.
			if (cancelled) return;
			finish();
			reject(error);
		});
		child.once("exit", (code) => {
			exited = true;
			exitCode = code;
			if (cancelled) complete(code);
		});
		child.once("close", (code) => complete(code));
		if (invocation.signal?.aborted) terminate();
	});
