import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type ToolRenderContext = Parameters<
	NonNullable<ToolDefinition["renderCall"]>
>[2];

interface DisplayArgs {
	executable?: string;
	args?: string[];
	cwd?: string;
}

// Untrusted argv/output must not issue terminal commands or reorder visible text.
function safeText(text: string): string {
	return text.replace(
		/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function argument(value: string): string {
	return /^[a-zA-Z0-9_./:=+,@%-]+$/.test(value)
		? value
		: safeText(JSON.stringify(value));
}

function preview(text: string, expanded: boolean): string {
	if (expanded || text.length <= 240) return text;
	return `${Array.from(text).slice(0, 240).join("")} … [펼쳐서 전체 보기]`;
}

export function renderCall(
	args: DisplayArgs,
	theme: Theme,
	context: ToolRenderContext,
): Text {
	// Arguments can arrive incrementally; rendering must not require a valid call.
	const argv = [
		typeof args.executable === "string" ? argument(args.executable) : "…",
		...(Array.isArray(args.args)
			? args.args.filter((value) => typeof value === "string").map(argument)
			: []),
	].join(" ");
	const cwd = typeof args.cwd === "string" ? args.cwd : context.cwd;
	return new Text(
		[
			theme.fg("toolTitle", theme.bold("sudo_exec")) +
				theme.fg("muted", " · argv (표시용, 셸 아님)"),
			theme.fg("accent", preview(argv, context.expanded)),
			theme.fg("dim", `cwd: ${preview(argument(cwd), context.expanded)}`),
		].join("\n"),
		0,
		0,
	);
}

export function renderResult(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: ToolRenderContext,
): Text {
	const details = result.details as
		| { code?: number; cancelled?: boolean; timedOut?: boolean }
		| undefined;
	const failed =
		context.isError ||
		details?.cancelled ||
		details?.timedOut ||
		(details?.code != null && details.code !== 0);
	const status = options.isPartial
		? "실행 중…"
		: failed
			? "실패 / 취소"
			: details?.code === 0
				? "완료 · exit=0"
				: "결과";
	const output = safeText(
		result.content
			.filter((item) => item.type === "text")
			.map((item) => item.text ?? "")
			.join("\n"),
	);
	const lines = output.split("\n");
	const shown = options.expanded
		? output
		: lines
				.slice(0, 6)
				.map((line) => preview(line, false))
				.join("\n");
	return new Text(
		[
			theme.fg(
				options.isPartial ? "warning" : failed ? "error" : "muted",
				status,
			),
			shown,
			...(!options.expanded && lines.length > 6
				? [theme.fg("dim", "… [펼쳐서 전체 보기]")]
				: []),
		]
			.filter(Boolean)
			.join("\n"),
		0,
		0,
	);
}
