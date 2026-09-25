import { expect, test } from "bun:test";
import {
	mkdtemp,
	mkdir,
	readFile,
	rm,
	writeFile,
	copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise generated-doc drift handling without rewriting the repository's docs.
test("diagram sync detects drift, is idempotent, and rejects missing markers", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sudo-docs-"));
	try {
		await mkdir(join(root, "scripts"));
		await mkdir(join(root, "docs/diagram"), { recursive: true });
		await copyFile(
			new URL("../scripts/sync-diagrams.ts", import.meta.url),
			join(root, "scripts/sync-diagrams.ts"),
		);
		let document = "# Test\n";
		for (const name of ["modules", "auth-exec", "grant-lifecycle"]) {
			document += `<!-- diagram:${name}:start -->\n<!-- diagram:${name}:end -->\n`;
			await writeFile(
				join(root, `docs/diagram/${name}.mmd`),
				"flowchart LR\n  A --> B\n",
			);
		}
		const path = join(root, "docs/architecture.md");
		await writeFile(path, document);
		const run = async (...args: string[]) => {
			const child = Bun.spawn(
				[process.execPath, join(root, "scripts/sync-diagrams.ts"), ...args],
				{ stdout: "pipe", stderr: "pipe" },
			);
			return {
				code: await child.exited,
				error: await new Response(child.stderr).text(),
			};
		};
		expect((await run("--check")).code).toBe(1);
		expect(await readFile(path, "utf8")).toBe(document);
		expect((await run()).code).toBe(0);
		const synced = await readFile(path, "utf8");
		expect(synced.match(/```mermaid/g)).toHaveLength(3);
		expect(synced.match(/!\[[^\]]+\]\(diagram\/[^)]+\.png\)/g)).toHaveLength(3);
		expect(synced.match(/\[SVG\]\(diagram\/[^)]+\.svg\)/g)).toHaveLength(3);
		expect((await run("--check")).code).toBe(0);
		expect((await run()).code).toBe(0);
		expect(await readFile(path, "utf8")).toBe(synced);
		await writeFile(path, "# Missing markers\n");
		const invalid = await run();
		expect(invalid.code).not.toBe(0);
		expect(invalid.error).toContain("Expected one marker pair");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
