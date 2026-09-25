import { expect, test } from "bun:test";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { renderCall, renderResult } from "../src/render.js";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
const styles: { color: string; text: string }[] = [];
const theme = {
	fg: (color: string, text: string) => { styles.push({ color, text }); return text; },
	bold: (text: string) => text,
} as Theme;
const context = { cwd: "/tmp/작업", expanded: false, isError: false } as ToolRenderContext;
const result = (text: string, details?: unknown) => ({ content: [{ type: "text", text }], details });
const show = (text: string, details?: unknown, expanded = false, isError = false, width = 120) =>
	renderResult(result(text, details), { expanded, isPartial: false }, theme, { ...context, isError }).render(width);

test("call keeps JSON boundaries, escapes controls, and hides only default cwd", () => {
	const args = { executable: "/usr/bin/printf", args: ["", "a b", 'a"b', "\n", "\x1b[2J", "\u202eevil", "한글"] };
	const before = structuredClone(args);
	const component = renderCall(args, theme, context);
	const text = component.render(120).join("\n");
	expect(text).toContain('/usr/bin/printf "" "a b" "a\\"b" "\\n" "\\u001b[2J"');
	expect(text).toContain("\\u202e");
	expect(text).not.toContain("cwd:");
	expect(text).not.toContain("\x1b");
	expect(args).toEqual(before);
	const expanded = renderCall(args, theme, { ...context, expanded: true }).render(120).join("\n");
	expect(expanded).toContain('cwd: "/tmp/작업"');
	expect(expanded).toContain("not a shell command");
	for (const width of [1, 2, 10, 40, 80])
		for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});

test("partial and malformed args render; overridden cwd and long argv give explicit expansion", () => {
	expect(renderCall({ args: ["a", null, 42] } as never, theme, context).render(80).join(" ")).toContain("… a … …");
	const args = { executable: "/bin/echo", args: ["x".repeat(400) + "TAIL"], cwd: "/override/" + "z".repeat(400) + "END" };
	const before = structuredClone(args);
	const short = renderCall(args, theme, context).render(120).join("\n");
	expect(short.replace(/\n/g, " ")).toMatch(/cwd:\s+\/override\//);
	expect(short).toContain("to expand");
	expect(short).not.toContain("TAIL");
	expect(short).not.toContain("END");
	const full = renderCall(args, theme, { ...context, expanded: true }).render(1000).join("\n");
	expect(full).toContain("TAIL");
	expect(full).toContain("END");
	expect(args).toEqual(before);
});

test("first eight visual rows and logical hidden counts, with one muted entire hint", () => {
	styles.length = 0;
	const twentySeven = Array.from({ length: 27 }, (_, i) => `row ${i + 1}`).join("\n");
	const lines = show(twentySeven);
	expect(lines).toHaveLength(11);
	expect(lines.join("\n")).toContain("row 8");
	expect(lines.join("\n")).not.toContain("row 9\n");
	expect(lines.at(-1)).toBe("... (19 more lines • Ctrl+O to expand)");
	expect(styles).toContainEqual({ color: "muted", text: "... (19 more lines • Ctrl+O to expand)" });
	expect(show(Array.from({ length: 9 }, (_, i) => `row ${i}`).join("\n")).at(-1)).toBe("... (1 more line • Ctrl+O to expand)");
	const wrapped = show("x".repeat(400) + "\nnext\nlast", undefined, false, false, 20);
	expect(wrapped.slice(1, 9)).toHaveLength(8);
	expect(wrapped.join("")).toContain("3 more lines"); // first source line is only partly visible
});

test("uses the current app.tools.expand key and restyles the whole notice", () => {
	const manager = getKeybindings();
	const original = manager.getKeys;
	manager.getKeys = (binding) => binding === "app.tools.expand" ? ["ctrl+shift+p"] : original.call(manager, binding);
	try {
		styles.length = 0;
		const hint = show(Array.from({ length: 9 }, (_, i) => `row ${i}`).join("\n")).at(-1);
		expect(hint).toBe("... (1 more line • Ctrl+Shift+P to expand)");
		expect(styles).toContainEqual({ color: "muted", text: hint! });
	} finally {
		manager.getKeys = original;
	}
});

test("resizing recomputes preview and narrow overwide glyphs never overflow", () => {
	const component = renderResult(result("한글😀".repeat(40) + " TAIL\nnext"), { expanded: false, isPartial: false }, theme, context);
	const narrow = component.render(12);
	expect(narrow.join("\n")).not.toContain("TAIL");
	const wide = component.render(300);
	expect(wide.join("\n")).toContain("TAIL");
	expect(wide.join("\n")).toContain("next");
	expect(component.render(12)).toEqual(narrow);
	for (const width of [1, 2, 3, 12, 300]) {
		const rows = component.render(width);
		expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
	}
	expect(component.render(1).join("")).toContain("?");
});

test("generated outcome header is removed only with evidence; errors and warnings remain", () => {
	const header = "exit=0, cancelled=false, timedOut=false, truncated=false\n";
	expect(show(header + "hello", { code: 0, cancelled: false, timedOut: false, truncated: false }).join("\n")).toBe("Completed · exit=0\n\nhello");
	expect(show(header + "hello", null).join("\n")).toContain(header.trim());
	expect(show("prefix " + header + "hello", { code: 0 }).join("\n")).toContain(header.trim());
	expect(show(header + "hello", { code: 1 }).join("\n")).toContain(header.trim());
	const error = "Error: exit=7, cancelled=false, timedOut=false, truncated=true\n";
	const warning = "sudo -k cleanup failed; credential cache may remain valid";
	const content = error + warning + "\n" + Array.from({ length: 25 }, (_, i) => `row ${i}`).join("\n");
	const collapsed = show(content, null, false, true).join("\n");
	const expanded = show(content, null, true, true).join("\n");
	for (const text of [collapsed, expanded]) {
		expect(text).toContain("Error · exit=7");
		expect(text).toContain(warning);
		expect(text).toContain("[Output truncated during capture · expanding will not show missing output]");
		expect(text).toContain(error.trim());
	}
	expect(collapsed).not.toContain("row 24");
	expect(expanded).toContain("row 24");
	expect(show("Error: unexpected", null, false, true).join("\n")).toContain("Error: unexpected");
	expect(show("exit=2, cancelled=false, timedOut=false, truncated=false\nfailed", null, false, true).join("\n")).toContain("exit=2, cancelled=false, timedOut=false, truncated=false\n\nfailed");
	expect(show("exit=0, cancelled=true, timedOut=false, truncated=false\ncancelled", null, false, true).join("\n")).toContain("Error · Cancelled");
	expect(show("exit=0, cancelled=false, timedOut=true, truncated=false\ntimed out", null, false, true).join("\n")).toContain("Error · Timed out");
	expect(show("ordinary output\n" + warning, null).join("\n")).toContain(warning);
	expect(show("retained", { truncated: true }).join("\n")).toContain("truncated");
});

test("state precedence, partial result, empty/unclassified content, and control safety", () => {
	for (const [details, label] of [
		[{ code: 0, cancelled: true }, "Cancelled"],
		[{ code: 0, timedOut: true }, "Timed out"],
		[{ code: 2 }, "Failed · exit=2"],
		[null, "Result (status unknown)"],
	] as const) expect(show("", details).join("\n")).toBe(label);
	expect(show("", { code: 0 }, false, true).join("\n")).toBe("Error · exit=0");
	const running = renderResult(result("Checking access and running command…"), { expanded: false, isPartial: true }, theme, context).render(80).join("\n");
	expect(running).toBe("Running…");
	expect(show("\x1b[2J\u202eTAIL", { code: 0 }, true).join("\n")).toContain("\\u001b[2J\\u202eTAIL");
	const frozen = Object.freeze({ content: Object.freeze([Object.freeze({ type: "text", text: "one\ntwo" })]), details: Object.freeze({ code: 0 }) });
	expect(renderResult(frozen as never, { expanded: true, isPartial: false }, theme, context).render(80).join("\n")).toContain("two");
});

test("call is limited by visual rows, not 240 characters, and explicit default cwd stays hidden", () => {
	const argv = "x".repeat(300) + "TAIL";
	const full = renderCall({ executable: "/bin/echo", args: [argv], cwd: context.cwd }, theme, context).render(1000).join("\n");
	expect(full).toContain("TAIL");
	expect(full).not.toContain("cwd:");
	styles.length = 0;
	const narrow = renderCall({ executable: "/bin/echo", args: [argv], cwd: "/override/" + "z".repeat(300) }, theme, context).render(12);
	expect(narrow.join("\n")).toMatch(/more\nline/);
	expect(styles.some(({ color, text }) => color === "muted" && text.includes("more line"))).toBe(true);
	for (const row of narrow) expect(visibleWidth(row)).toBeLessThanOrEqual(12);
});

test("null exit headers distinguish timeout and cancellation without coercing to success", () => {
	const timeout = "Error: exit=null, cancelled=false, timedOut=true, truncated=false\nslow";
	expect(show(timeout, null, false, true).join("\n")).toContain("Error · Timed out\nError: exit=null, cancelled=false, timedOut=true, truncated=false\n\nslow");
	const cancel = "exit=null, cancelled=true, timedOut=false, truncated=false\ninterrupted";
	expect(show(cancel, null, false, true).join("\n")).toContain("Error · Cancelled\nexit=null, cancelled=true, timedOut=false, truncated=false\n\ninterrupted");
	expect(show(cancel, { code: 0, cancelled: true, timedOut: false, truncated: false }).join("\n")).toContain("exit=null");
	expect(show("exit=null, cancelled=false, timedOut=false, truncated=false\nunknown", { code: null, cancelled: false, timedOut: false, truncated: false }).join("\n")).toBe("Result (status unknown)\n\nunknown");
});

test("short call title and argv share a row", () => {
	expect(renderCall({ executable: "/usr/bin/id", args: [] }, theme, context).render(80)).toEqual(["sudo_exec /usr/bin/id"]);
});
