/** Direct-child transport: terminal handoff, bounded capture and best-effort cancellation. */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

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
	onOutput?: (output: Pick<Outcome, "stdout" | "stderr" | "truncated" | "displayOutput" | "displayTruncated">) => void;
	/** Retain a separate arrival-ordered display tail even without a live UI. */
	captureDisplay?: boolean;
};
export type Outcome = {
	code: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	/** Bounded UI tail in parent-observed chunk order, not a child-side ordering guarantee. */
	displayOutput?: string;
	displayTruncated?: boolean;
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

// Fixed-size byte ring: no per-chunk prefix copying or unbounded event history.
class DisplayTail {
	private readonly bytes = Buffer.allocUnsafe(OUTPUT_LIMIT);
	private start = 0;
	private length = 0;
	truncated = false;

	append(chunk: Buffer): void {
		if (!chunk.length) return;
		if (chunk.length >= OUTPUT_LIMIT) {
			this.truncated ||= this.length > 0 || chunk.length > OUTPUT_LIMIT;
			chunk.copy(this.bytes, 0, chunk.length - OUTPUT_LIMIT);
			this.start = 0;
			this.length = OUTPUT_LIMIT;
			return;
		}
		const dropped = Math.max(0, this.length + chunk.length - OUTPUT_LIMIT);
		if (dropped) this.truncated = true;
		this.start = (this.start + dropped) % OUTPUT_LIMIT;
		this.length = Math.min(OUTPUT_LIMIT, this.length + chunk.length);
		const end = (this.start + this.length - chunk.length) % OUTPUT_LIMIT;
		const first = Math.min(chunk.length, OUTPUT_LIMIT - end);
		chunk.copy(this.bytes, end, 0, first);
		if (first < chunk.length) chunk.copy(this.bytes, 0, first);
	}

	snapshot(): { text: string; truncated: boolean } {
		const retained = Buffer.allocUnsafe(this.length);
		const first = Math.min(this.length, OUTPUT_LIMIT - this.start);
		this.bytes.copy(retained, 0, this.start, this.start + first);
		if (first < this.length) this.bytes.copy(retained, first, 0, this.length - first);
		// A ring can begin mid-codepoint. Discard only that partial codepoint.
		let offset = 0;
		if (this.truncated)
			while (offset < retained.length && (retained[offset] & 0xc0) === 0x80) offset++;
		let text = retained.subarray(offset).toString("utf8");
		let lines = 0;
		for (let i = text.length - 1; i >= 0; i--) {
			if (text[i] !== "\n") continue;
			if (++lines >= 1900) {
				text = text.slice(i + 1);
				return { text, truncated: true };
			}
		}
		return { text, truncated: this.truncated };
	}
}

function prefixText(bytes: Buffer | undefined, length: number, clipped: boolean): string {
	if (!bytes) return "";
	const decoder = new StringDecoder("utf8");
	const text = decoder.write(bytes.subarray(0, length));
	return clipped ? text : text + decoder.end();
}

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
		let stdoutClipped = false;
		let stderrClipped = false;
		let truncated = false;
		const tail = invocation.captureDisplay ? new DisplayTail() : undefined;
		const stdoutDecoder = tail ? new StringDecoder("utf8") : undefined;
		const stderrDecoder = tail ? new StringDecoder("utf8") : undefined;
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
					const display = tail?.snapshot();
					invocation.onOutput?.({
						stdout: prefixText(stdout, stdoutLength, stdoutClipped),
						stderr: prefixText(stderr, stderrLength, stderrClipped),
						truncated,
						displayOutput: display?.text,
						displayTruncated: display?.truncated,
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
			if (length < chunk.length) {
				stdoutClipped = true;
				truncated = true;
			}
			const text = stdoutDecoder?.write(chunk);
			if (text) tail?.append(Buffer.from(text));
			if (length || tail) scheduleUpdate();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (settled) return;
			const length = Math.min(chunk.length, OUTPUT_LIMIT - stderrLength);
			if (length) {
				stderr ??= Buffer.allocUnsafe(OUTPUT_LIMIT);
				chunk.copy(stderr, stderrLength, 0, length);
				stderrLength += length;
			}
			if (length < chunk.length) {
				stderrClipped = true;
				truncated = true;
			}
			const text = stderrDecoder?.write(chunk);
			if (text) tail?.append(Buffer.from(text));
			if (length || tail) scheduleUpdate();
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
			const stdoutEnd = stdoutDecoder?.end();
			if (stdoutEnd) tail?.append(Buffer.from(stdoutEnd));
			const stderrEnd = stderrDecoder?.end();
			if (stderrEnd) tail?.append(Buffer.from(stderrEnd));
			const display = tail?.snapshot();
			finish();
			resolve({
				code,
				stdout: prefixText(stdout, stdoutLength, stdoutClipped),
				stderr: prefixText(stderr, stderrLength, stderrClipped),
				truncated,
				displayOutput: display?.text,
				displayTruncated: display?.truncated,
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
