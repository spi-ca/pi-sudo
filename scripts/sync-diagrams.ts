/** Keep readable Markdown diagrams generated from one canonical set of Mermaid sources. */
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
	throw new Error("Usage: bun scripts/sync-diagrams.ts [--check]");
}
const check = args[0] === "--check";
const document = Bun.file(new URL("../docs/architecture.md", import.meta.url));
const original = await document.text();
let updated = original;
for (const name of ["modules", "auth-exec", "grant-lifecycle"]) {
	const begin = `<!-- diagram:${name}:start -->`;
	const end = `<!-- diagram:${name}:end -->`;
	if (updated.split(begin).length !== 2 || updated.split(end).length !== 2) {
		throw new Error(`Expected one marker pair for ${name}`);
	}
	const start = updated.indexOf(begin) + begin.length;
	const stop = updated.indexOf(end);
	if (stop < start) throw new Error(`Reversed diagram markers for ${name}`);
	const source = await Bun.file(
		new URL(`../docs/diagram/${name}.mmd`, import.meta.url),
	).text();
	updated = `${updated.slice(0, start)}\n\n![${name} 다이어그램](diagram/${name}.png)\n\n[Mermaid 원본](diagram/${name}.mmd) · [SVG](diagram/${name}.svg)\n\n<details>\n<summary>Mermaid 코드 보기</summary>\n\n\`\`\`mermaid\n${source.trim()}\n\`\`\`\n\n</details>\n\n${updated.slice(stop)}`;
}
if (check) {
	if (updated !== original) {
		console.error("Diagram blocks are stale. Run bun run docs:diagrams.");
		process.exitCode = 1;
	} else {
		console.log("All 3 Markdown diagrams match their Mermaid sources.");
	}
} else {
	if (updated !== original) await Bun.write(document, updated);
	console.log("Synchronized 3 Mermaid diagram blocks.");
}
export {};
