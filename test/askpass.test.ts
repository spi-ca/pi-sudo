import { expect, test } from "bun:test";
import { trustedAskpass } from "../src/askpass.js";
import type { Stats } from "node:fs";

function fake(
	overrides: Record<
		string,
		{ uid?: number; mode?: number; type?: "file" | "dir" }
	> = {},
) {
	return {
		realpath: (_path: string) => "/system/bin/helper",
		stat: (path: string) => {
			const entry = overrides[path] ?? {};
			return {
				uid: entry.uid ?? 0,
				mode: entry.mode ?? 0o755,
				isFile: () =>
					(entry.type ?? (path === "/system/bin/helper" ? "file" : "dir")) ===
					"file",
				isDirectory: () =>
					(entry.type ?? (path === "/system/bin/helper" ? "file" : "dir")) ===
					"dir",
			} as Stats;
		},
	};
}

test("explicit absolute helper resolves symlinks and checks canonical path through root", () => {
	expect(trustedAskpass("/symlink/helper", fake())).toBe("/system/bin/helper");
	for (const value of [undefined, "relative", "", "/nul\0x"])
		expect(() => trustedAskpass(value, fake())).toThrow("absolute");
	for (const [path, entry] of [
		["/system/bin/helper", { uid: 1000 }],
		["/system/bin/helper", { mode: 0o777 }],
		["/system/bin/helper", { mode: 0o644 }],
		["/system/bin/helper", { type: "dir" }],
		["/system", { uid: 1000 }],
		["/system/bin", { mode: 0o775 }],
		["/", { mode: 0o777 }],
		["/system", { type: "file" }],
	] as const)
		expect(() =>
			trustedAskpass("/symlink/helper", fake({ [path]: entry })),
		).toThrow("canonical ancestors");
	expect(() =>
		trustedAskpass("/symlink/helper", {
			...fake(),
			realpath: () => {
				throw Error("missing");
			},
		}),
	).toThrow("canonical ancestors");
});
