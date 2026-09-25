import { expect, test } from "bun:test";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderCall, renderResult } from "../src/render.js";

type ToolRenderContext = Parameters<
	NonNullable<ToolDefinition["renderCall"]>
>[2];

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;
const context = {
	cwd: "/tmp/작업",
	expanded: false,
	isError: false,
} as ToolRenderContext;

test("call shows argv boundaries and cwd without terminal control sequences", () => {
	const args = {
		executable: "/usr/bin/printf",
		args: ["", "a b", 'a"b', "\n", "\x1b[2J", "\u202eevil", "한글"],
	};
	const before = structuredClone(args);
	const component = renderCall(args, theme, context);
	const text = component.render(120).join("\n");
	expect(text).toContain('/usr/bin/printf "" "a b" "a\\"b" "\\n" "\\u001b[2J"');
	expect(text).toContain("\\u202e");
	expect(text).toContain("/tmp/작업");
	expect(text).not.toContain("\x1b");
	expect(args).toEqual(before);
	for (const width of [10, 40, 80]) {
		for (const line of component.render(width))
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
});

test("partial args are safe and long commands expand without losing the tail", () => {
	expect(renderCall({}, theme, context).render(80).join("\n")).toContain("…");
	const args = {
		executable: "/bin/echo",
		args: ["x".repeat(400) + "TAIL"],
		cwd: "/override",
	};
	expect(renderCall(args, theme, context).render(80).join("\n")).not.toContain(
		"TAIL",
	);
	const expanded = renderCall(args, theme, { ...context, expanded: true })
		.render(1000)
		.join("\n");
	expect(expanded).toContain("TAIL");
	expect(expanded).toContain("/override");
});

test("results distinguish pending, errors, success and unclassified results; output is safely expandable", () => {
	const result = {
		content: [{ type: "text", text: "\x1b[2Jline\n".repeat(8) + "TAIL" }],
		details: { code: 0 },
	};
	const show = (expanded: boolean, isPartial = false, isError = false) =>
		renderResult(result, { expanded, isPartial }, theme, {
			...context,
			isError,
		})
			.render(120)
			.join("\n");
	expect(show(false, true)).toContain("실행 중");
	expect(show(false)).toContain("완료 · exit=0");
	expect(show(false, false, true)).toContain("실패 / 취소");
	expect(show(false, false, true)).not.toContain("완료");
	expect(show(false)).not.toContain("TAIL");
	expect(show(true)).toContain("TAIL");
	expect(show(true)).not.toContain("\x1b");
	expect(
		renderResult(
			{ content: [] },
			{ expanded: false, isPartial: false },
			theme,
			context,
		)
			.render(80)
			.join("\n"),
	).not.toContain("완료");
});
