import { expect, test } from "bun:test";
import type { Stats } from "node:fs";
import { sudoBackend, type BackendFiles, type Invocation, type Outcome } from "../src/process.js";
import { SudoAccess } from "../src/sudo.js";

const classic = "/usr/bin/sudo", rust = "/usr/bin/sudo-rs";
type Entry = { type?: "file" | "dir" | "link"; uid?: number; mode?: number; ino?: number; size?: number; mtimeMs?: number; ctimeMs?: number };
function files() {
	const entries = new Map<string, Entry>([[classic, { type: "file", ino: 1 }], [rust, { type: "file", ino: 2 }]]);
	const links = new Map<string, string>();
	const reads: string[] = [];
	const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
	const stat = (path: string): Stats => {
		reads.push(path);
		const entry = entries.get(path) ?? (["/", "/usr", "/usr/bin", "/system", "/system/bin"].includes(path) ? { type: "dir" } : undefined);
		if (!entry) throw missing();
		return { uid: 0, gid: 0, mode: 0o755, dev: 1, ino: 10, size: 100, mtimeMs: 1, ctimeMs: 1, ...entry,
			isFile: () => entry.type === "file", isDirectory: () => entry.type === "dir" } as unknown as Stats;
	};
	const fs: BackendFiles = {
		lstat: stat,
		stat,
		realpath: (path) => { const target = links.get(path) ?? path; stat(target); return target; },
	};
	return { fs, entries, links, reads };
}
const ok: Outcome = { code: 0, stdout: "", stderr: "", cancelled: false, timedOut: false, truncated: false };
function accessFixture(f = files(), run = (_call: Invocation): Promise<Outcome> => Promise.resolve(ok)) {
	const calls: Invocation[] = [];
	const access = new SudoAccess(async call => { calls.push(call); return run(call); }, () => sudoBackend(f.fs));
	return { ...f, access, calls };
}

test("AUTO prefers fixed system sudo even when its provider is Rust; only absence selects sudo-rs", () => {
	const f = files();
	expect(sudoBackend(f.fs).selectedPath).toBe(classic);
	expect(f.reads).not.toContain(rust);
	f.entries.delete(classic);
	expect(sudoBackend(f.fs)).toMatchObject({ selectedPath: rust, path: rust });
	f.entries.delete(rust);
	expect(() => sudoBackend(f.fs)).toThrow("missing");
	expect(f.reads.every(path => path.startsWith("/"))).toBe(true);
});

test("unsafe existing default never falls back, including inaccessible and dangling links", () => {
	for (const entry of [{ type: "file", uid: 1000 }, { type: "file", mode: 0o775 },
		{ type: "file", mode: 0o644 }, { type: "dir" }, { type: "link", uid: 1000 }] as Entry[]) {
		const f = files(); f.entries.set(classic, entry);
		expect(() => sudoBackend(f.fs)).toThrow("no backend fallback");
		expect(f.reads).not.toContain(rust);
	}
	const f = files(); f.links.set(classic, "/missing/target");
	expect(() => sudoBackend(f.fs)).toThrow("no backend fallback");
	expect(f.reads).not.toContain(rust);
	expect(() => sudoBackend({ ...f.fs, lstat: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } })).toThrow("denied");
});

test("trusted symlink targets are canonicalized; both route and canonical ancestors are trusted", () => {
	const f = files(); f.entries.set(classic, { type: "link", mode: 0o777 });
	f.links.set(classic, "/system/bin/sudo"); f.entries.set("/system/bin/sudo", { type: "file" });
	expect(sudoBackend(f.fs)).toMatchObject({ selectedPath: classic, path: "/system/bin/sudo" });
	for (const path of ["/", "/usr", "/usr/bin", "/system", "/system/bin"]) {
		for (const entry of [{ type: "dir", uid: 1000 }, { type: "dir", mode: 0o777 }, { type: "file" }] as Entry[]) {
			f.entries.set(path, entry);
			expect(() => sudoBackend(f.fs)).toThrow("canonical ancestors");
			f.entries.delete(path);
		}
	}
	f.entries.set("/system/bin/sudo", { type: "file", mode: 0o777 });
	expect(() => sudoBackend(f.fs)).toThrow("no backend fallback");
});

test("unsafe standalone sudo-rs also fails closed", () => {
	const f = files(); f.entries.delete(classic); f.entries.set(rust, { type: "file", uid: 1000 });
	expect(() => sudoBackend(f.fs)).toThrow("sudo-rs");
});

for (const provider of [classic, rust]) {
	test(`${provider}: lazy selection pins auth, askpass, probe, exec, reauth and cleanup`, async () => {
		const f = files(); if (provider === rust) f.entries.delete(classic);
		const a = accessFixture(f);
		expect(f.reads).toHaveLength(0);
		await a.access.unlock(180, true, () => "/trusted/helper");
		expect(a.calls.map(call => call.args)).toEqual([["-k"], ["-A", "-v"], ["-n", "--", "/usr/bin/true"]]);
		expect(a.calls[1]).toMatchObject({ askpass: "/trusted/helper", interactive: false });
		expect(a.calls.filter(call => call.askpass)).toHaveLength(1);
		await a.access.exec("/usr/bin/id", []);
		const ticket = a.access.beginReauth(); await a.access.reauth(ticket, true);
		await a.access.lock();
		expect(a.calls.every(call => call.executable === provider)).toBe(true);
	});
	test(`${provider}: failed/unsupported askpass is explicit and never retries auth or provider`, async () => {
		const f = files(); if (provider === rust) f.entries.delete(classic);
		const a = accessFixture(f, async call => call.args[0] === "-A" ? { ...ok, code: 1 } : ok);
		await expect(a.access.unlock(1, true, () => "/trusted/helper")).rejects.toThrow("must support askpass (-A); no terminal/backend fallback");
		expect(a.calls.map(call => call.args)).toEqual([["-k"], ["-A", "-v"], ["-k"]]);
		expect(a.calls.every(call => call.executable === provider)).toBe(true);
		expect(a.access.remainingMs()).toBe(0);
	});
	test(`${provider}: ordinary nonzero retains grant; auth/probe failure never switches backend`, async () => {
		for (const phase of ["-v", "probe", "exec"]) {
			const f = files(); if (provider === rust) f.entries.delete(classic);
			const a = accessFixture(f, async call => (call.args[0] === phase ||
				(call.args[0] === "-n" && call.args[2] === (phase === "probe" ? "/usr/bin/true" : "/usr/bin/id"))) ? { ...ok, code: 1 } : ok);
			if (phase === "exec") {
				await a.access.unlock(1, true); expect((await a.access.exec("/usr/bin/id", [])).code).toBe(1);
				expect(a.access.remainingMs()).toBeGreaterThan(0); await a.access.lock();
			} else {
				await expect(a.access.unlock(1, true)).rejects.toThrow(); expect(a.access.remainingMs()).toBe(0);
			}
			expect(a.calls.every(call => call.executable === provider)).toBe(true);
		}
	});
}

test("binary metadata replacement or permission change revokes before execution; changed cleanup never spawns", async () => {
	for (const change of [{ ino: 999 }, { size: 101 }, { mtimeMs: 2 }, { ctimeMs: 2 }, { mode: 0o777 }, { uid: 1000 }]) {
		const a = accessFixture(); await a.access.unlock(1, true);
		a.entries.set(classic, { type: "file", ino: 1, ...change });
		await expect(a.access.exec("/usr/bin/id", [])).rejects.toThrow("explicit /sudo unlock");
		expect(a.access.remainingMs()).toBe(0); expect(a.calls).toHaveLength(3);
		await expect(a.access.lock()).rejects.toThrow("credential cache may remain valid");
		expect(a.calls).toHaveLength(3);
	}
});

test("preferred path appearing or disappearing requires a fresh explicit unlock, not an automatic backend retry", async () => {
	for (const initiallyRust of [false, true]) {
		const f = files(); if (initiallyRust) f.entries.delete(classic);
		const a = accessFixture(f); await a.access.unlock(1, true);
		if (initiallyRust) f.entries.set(classic, { type: "file", ino: 1 }); else f.entries.delete(classic);
		expect(() => a.access.beginReauth()).toThrow("explicit /sudo unlock");
		expect(a.access.remainingMs()).toBe(0); expect(a.calls).toHaveLength(3);
		await expect(a.access.exec("/usr/bin/id", [])).rejects.toThrow("locked");
		await a.access.unlock(1, true);
		expect(a.calls.slice(3).every(call => call.executable === (initiallyRust ? classic : rust))).toBe(true);
		await a.access.lock();
	}
});

test("symlink retarget or link replacement invalidates a live grant", async () => {
	for (const retarget of [false, true]) {
		const f = files(); f.entries.set(classic, { type: "link", ino: 1, mode: 0o777 });
		f.links.set(classic, rust);
		const a = accessFixture(f); await a.access.unlock(1, true);
		if (retarget) { f.entries.set("/system/bin/sudo", { type: "file" }); f.links.set(classic, "/system/bin/sudo"); }
		else f.entries.set(classic, { type: "link", ino: 3, mode: 0o777 });
		await expect(a.access.exec("/usr/bin/id", [])).rejects.toThrow("changed");
		expect(a.calls).toHaveLength(3); expect(a.access.remainingMs()).toBe(0);
	}
});

test("replacement during auth, probe, or nonzero exec is detected after child completion, with no retry", async () => {
	for (const phase of ["-v", "probe", "exec"]) {
		const f = files();
		const a = accessFixture(f, async call => {
			if (call.args[0] === phase || (call.args[0] === "-n" && call.args[2] === (phase === "probe" ? "/usr/bin/true" : "/usr/bin/id"))) {
				f.entries.set(classic, { type: "file", ino: 50 }); return { ...ok, code: 1 };
			}
			return ok;
		});
		if (phase === "exec") { await a.access.unlock(1, true); await expect(a.access.exec("/usr/bin/id", [])).rejects.toThrow("changed"); }
		else await expect(a.access.unlock(1, true)).rejects.toThrow("changed");
		expect(a.access.remainingMs()).toBe(0);
		expect(a.calls).toHaveLength(phase === "-v" ? 2 : phase === "probe" ? 3 : 4);
	}
});

test("unsafe selection performs no auth, probe, exec, or fallback children", async () => {
	const a = accessFixture(); a.entries.set(classic, { type: "file", mode: 0o777 });
	await expect(a.access.unlock(1, true)).rejects.toThrow("no backend fallback");
	expect(a.calls).toHaveLength(0); expect(a.access.remainingMs()).toBe(0);
});

test("pinned identity is a snapshot even if an injected resolver reuses its object", async () => {
	const backend = { selectedPath: classic, path: classic, identity: "original" };
	const calls: Invocation[] = [];
	const access = new SudoAccess(async call => { calls.push(call); return ok; }, () => backend);
	await access.unlock(1, true); backend.identity = "replaced";
	await expect(access.exec("/usr/bin/id", [])).rejects.toThrow("changed");
	expect(access.remainingMs()).toBe(0); expect(calls).toHaveLength(3);
});

for (const provider of [classic, rust]) {
	test(`${provider}: initial cleanup failure and auth transport error never retry or substitute`, async () => {
		for (const phase of ["-k", "-v"]) {
			const f = files(); if (provider === rust) f.entries.delete(classic);
			const a = accessFixture(f, async call => {
				if (call.args[0] === phase) throw Error("spawn failed");
				return ok;
			});
			await expect(a.access.unlock(1, true)).rejects.toThrow("spawn failed");
			expect(a.access.remainingMs()).toBe(0);
			expect(a.calls.map(call => call.args)).toEqual(phase === "-k" ? [["-k"]] : [["-k"], ["-v"], ["-k"]]);
			expect(a.calls.every(call => call.executable === provider)).toBe(true);
		}
	});
}
