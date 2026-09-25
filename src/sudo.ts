/** Temporary grant policy, independent of Pi UI and of the concrete subprocess implementation. */
import { isAbsolute } from "node:path";
import type { Outcome, Runner } from "./process.js";

const AUTH_TIMEOUT_MS = 120_000;
const EXEC_TIMEOUT_MS = 60_000;
const INVALIDATE_TIMEOUT_MS = 5_000;
const MAX_MINUTES = 15;

export type Clock = {
	now(): number;
	wallNow?(): number;
	setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
	clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};
const clock: Clock = {
	now: () => performance.now(),
	wallNow: Date.now,
	setTimeout,
	clearTimeout,
};

export function validMinutes(input: string): number {
	if (!/^(?:[1-9]|1[0-5])$/.test(input))
		throw new Error("Duration must be a whole number of minutes from 1 to 15");
	return Number(input);
}

export function validateExec(
	executable: string,
	args: string[],
	cwd?: string,
): void {
	if (
		!isAbsolute(executable) ||
		executable.includes("\0") ||
		executable.endsWith("/")
	)
		throw new Error("Executable must be an absolute file path");
	if (
		!Array.isArray(args) ||
		args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
	)
		throw new Error("Arguments must be strings without NUL bytes");
	if (cwd !== undefined && (!isAbsolute(cwd) || cwd.includes("\0")))
		throw new Error("Working directory must be absolute");
}

/**
 * A process-local admission gate, not an OS capability or exclusive sudo cache.
 * One auth/exec operation may run at a time; lock closes admission synchronously
 * and waits for that operation before a final best-effort timestamp invalidation.
 */
export class SudoAccess {
	private deadline?: number;
	private wallDeadline?: number;
	private timer?: ReturnType<typeof setTimeout>;
	private active?: Promise<unknown>;
	private abort?: AbortController;
	private locking?: Promise<void>;
	// Revocation advances this fence so a late authentication cannot reopen access.
	private generation = 0;
	// A possibly live direct sudo process makes another grant unsafe in this runtime.
	private poisoned = false;

	private async invoke(invocation: Parameters<Runner>[0]): Promise<Outcome> {
		const result = await this.run(invocation);
		if (result.terminationUnconfirmed) {
			this.poisoned = true;
			throw new Error(
				"sudo process termination could not be confirmed. Inspect running privileged processes; restart Pi before another unlock.",
			);
		}
		return result;
	}

	constructor(
		private readonly run: Runner,
		private readonly sudo: string,
		private readonly time: Clock = clock,
		private readonly onChange: () => void = () => {},
		private readonly onExpiryError: (error: unknown) => void = () => {},
	) {}

	/** Also initiates revocation when a delayed timer has not yet observed expiry. */
	remainingMs(): number {
		if (this.deadline === undefined) return 0;
		// Wall time additionally expires a grant across OS suspend; monotonic time
		// prevents clock rollback from extending it. A forward clock jump locks early.
		const remaining = Math.min(
			this.deadline - this.time.now(),
			this.wallDeadline === undefined
				? Infinity
				: this.wallDeadline - this.time.wallNow!(),
		);
		if (remaining <= 0) {
			void this.lock().catch(this.onExpiryError);
			return 0;
		}
		return remaining;
	}

	/** Remove logical authority before any asynchronous cleanup can fail or stall. */
	private clear(): void {
		this.generation++;
		this.deadline = undefined;
		this.wallDeadline = undefined;
		if (this.timer) this.time.clearTimeout(this.timer);
		this.timer = undefined;
		this.onChange();
	}

	// Reject contention rather than queueing privileged work across a grant boundary.
	private start<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.poisoned)
			throw new Error(
				"Sudo process termination was unconfirmed; inspect processes and restart Pi",
			);
		if (this.active || this.locking)
			throw new Error("Sudo is busy (unlock, execution or lock in progress)");
		const abort = new AbortController();
		this.abort = abort;
		const task = work(abort.signal);
		this.active = task;
		void task
			.finally(() => {
				if (this.active === task) {
					this.active = undefined;
					this.abort = undefined;
				}
			})
			.catch(() => {});
		return task;
	}

	private async invalidate(): Promise<void> {
		const result = await this.invoke({
			executable: this.sudo,
			args: ["-k"],
			timeoutMs: INVALIDATE_TIMEOUT_MS,
		});
		if (result.code !== 0 || result.cancelled || result.timedOut)
			throw new Error("sudo -k failed; credential cache may remain valid");
	}

	async unlock(
		minutes: number,
		interactive: boolean,
		askpass?: () => string,
	): Promise<void> {
		if (!interactive)
			throw new Error(
				"Unlock requires interactive Pi TUI and a real terminal on stdin/stdout/stderr",
			);
		if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES)
			throw new Error("Duration must be 1–15 minutes");
		if (this.active || this.locking) throw new Error("Sudo is busy");
		if (this.deadline !== undefined)
			throw new Error("Already unlocked; lock first (no automatic renewal)");
		const generation = ++this.generation;
		return this.start(async (signal) => {
			let invalidated = false;
			try {
				await this.invalidate();
				// Combining -k with -v ignores and does not update the cache.
				invalidated = true;
				if (signal.aborted) throw new Error("Unlock cancelled");
				// Resolve and recheck immediately before sudo's authentication child starts.
				const helper = askpass?.();
				const auth = await this.invoke({
					executable: this.sudo,
					args: helper ? ["-A", "-v"] : ["-v"],
					interactive: !helper,
					askpass: helper,
					timeoutMs: AUTH_TIMEOUT_MS,
					signal,
				});
				if (
					auth.code !== 0 ||
					auth.cancelled ||
					auth.timedOut ||
					signal.aborted
				)
					throw new Error("sudo authentication failed or cancelled");
				// Verify the execution path (same process parent, noninteractive, real command), not just -v.
				const probe = await this.invoke({
					executable: this.sudo,
					args: ["-n", "--", "/usr/bin/true"],
					timeoutMs: INVALIDATE_TIMEOUT_MS,
					signal,
				});
				if (
					probe.code !== 0 ||
					probe.cancelled ||
					probe.timedOut ||
					signal.aborted
				)
					throw new Error("Noninteractive sudo execution probe failed");
				if (generation !== this.generation)
					throw new Error("Unlock was revoked");
				// Start the fixed grant only after the real noninteractive probe succeeds.
				this.deadline = this.time.now() + minutes * 60_000;
				this.wallDeadline = this.time.wallNow
					? this.time.wallNow() + minutes * 60_000
					: undefined;
				this.timer = this.time.setTimeout(() => {
					void this.lock().catch(this.onExpiryError);
				}, minutes * 60_000);
				this.timer.unref?.();
				this.onChange();
			} catch (error) {
				this.clear();
				if (invalidated) {
					try {
						await this.invalidate();
					} catch {
						throw new Error(
							`sudo -k cleanup failed; credential cache may remain valid; original: ${String(error)}`,
						);
					}
				}
				throw error;
			}
		});
	}

	async exec(
		executable: string,
		args: string[],
		cwd?: string,
		signal?: AbortSignal,
		onOutput?: Parameters<Runner>[0]["onOutput"],
	): Promise<Outcome> {
		validateExec(executable, args, cwd);
		if (!this.remainingMs())
			throw new Error("Sudo is locked or expired; use /sudo unlock first");
		return this.start(async (ownSignal) => {
			let revoked = false;
			const onAbort = () => this.abort?.abort();
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const remaining = this.remainingMs();
				if (ownSignal.aborted || !remaining)
					throw new Error("Sudo execution cancelled or expired before spawn");
				const result = await this.invoke({
					executable: this.sudo,
					args: ["-n", "--", executable, ...args],
					cwd,
					timeoutMs: Math.min(EXEC_TIMEOUT_MS, remaining),
					signal: ownSignal,
					onOutput,
				});
				// Do not mutate runner-owned outcomes (a fake runner may reuse them).
				const outcome = {
					...result,
					cancelled: result.cancelled || ownSignal.aborted,
				};
				if (outcome.code !== 0 || outcome.cancelled || outcome.timedOut) {
					// Cannot distinguish sudo denial from command failure: fail closed and revoke the cache.
					this.clear();
					revoked = true;
					try {
						await this.invalidate();
					} catch {
						outcome.cleanupWarning =
							"sudo -k cleanup failed; credential cache may remain valid";
					}
				}
				return outcome;
			} catch (error) {
				if (!revoked) {
					this.clear();
					try {
						await this.invalidate();
					} catch {
						throw new Error(
							`sudo -k cleanup failed; credential cache may remain valid; original: ${String(error)}`,
						);
					}
				}
				throw error;
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		});
	}

	/** Repeated locks share cleanup; they never wait to close logical admission. */
	lock(): Promise<void> {
		if (this.locking) return this.locking;
		this.clear();
		this.abort?.abort();
		const active = this.active;
		// An in-flight sudo can update its timestamp: invalidate again after it settles.
		const task = (async () => {
			if (active) await active.catch(() => {});
			await this.invalidate();
		})();
		this.locking = task;
		void task
			.finally(() => {
				if (this.locking === task) this.locking = undefined;
			})
			.catch(() => {});
		return task;
	}
}
