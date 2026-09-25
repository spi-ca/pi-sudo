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
		let stdout: Buffer = Buffer.alloc(0);
		let stderr: Buffer = Buffer.alloc(0);
		let truncated = false;
		let cancelled = false;
		let timedOut = false;
		// Promise settlement, direct-child exit, and pipe closure are different events.
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		const append = (current: Buffer, chunk: Buffer) => {
			if (current.length + chunk.length > OUTPUT_LIMIT) truncated = true;
			if (current.length === OUTPUT_LIMIT) return current;
			return Buffer.concat([
				current,
				chunk.subarray(0, OUTPUT_LIMIT - current.length),
			]);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		const finish = () => {
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (settleTimer) clearTimeout(settleTimer);
			invocation.signal?.removeEventListener("abort", onAbort);
			child.stdout?.destroy();
			child.stderr?.destroy();
		};
		const complete = (code: number | null, terminationUnconfirmed = false) => {
			if (settled) return;
			finish();
			resolve({
				code,
				stdout: stdout.toString("utf8"),
				stderr: stderr.toString("utf8"),
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
