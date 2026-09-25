import { keyText, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type ToolRenderContext = Parameters<
	NonNullable<ToolDefinition["renderCall"]>
>[2];

interface DisplayArgs {
	executable?: string;
	args?: string[];
	cwd?: string;
}

const PREVIEW_ROWS = 8;
const CLEANUP_WARNING = "sudo -k cleanup failed; credential cache may remain valid";
const OUTCOME_HEADER = /^(?:Error: )?exit=(-?\d+|null), cancelled=(true|false), timedOut=(true|false), truncated=(true|false)\n/;

// Untrusted argv/output must not issue terminal commands or reorder visible text.
function safeText(text: string): string {
	return text.replace(
		/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function argument(value: string): string {
	return /^[a-zA-Z0-9_./:=+,@%-]+$/.test(value)
		? value
		: safeText(JSON.stringify(value));
}

function expandHint(): string {
	try {
		const key = keyText("app.tools.expand");
		if (key && !/[\u0000-\u001f\u007f-\u009f]/.test(key))
			return `${key.replace(/\b[a-z]/g, (char) => char.toUpperCase())} to expand`;
	} catch {
		// A renderer can also run without an initialized TUI keybinding manager.
	}
	return "Ctrl+O to expand";
}

// Pi owns the outer tool chrome. Rewrap on every render so resizing never keeps
// a narrow-width preview or a stale logical-line count.
function display(
	header: string[],
	body: string[],
	footers: string[],
	expanded: boolean,
	previewRows = PREVIEW_ROWS,
	styleHint: (text: string) => string = (text) => text,
): { render: (width: number) => string[]; invalidate: () => void } {
	return {
		render(width) {
			const columns = Math.max(1, width);
			const rows: string[] = [];
			const wrap = (line: string): string[] => {
				const result = wrapTextWithAnsi(line, columns);
				return result.flatMap((row, index) => {
					if (visibleWidth(row) <= columns) {
						// The TUI wrapper can emit an ANSI-only row just before an overwide glyph.
						if (visibleWidth(row) === 0 && visibleWidth(result[index + 1] ?? "") > columns) return [];
						return [row];
					}
					return ["?"];
				});
			};
			for (const line of header) rows.push(...wrap(line));
			let visibleLines = 0;
			let usedRows = 0;
			for (const line of body) {
				const wrapped = wrap(line);
				const count = expanded ? wrapped.length : Math.min(wrapped.length, previewRows - usedRows);
				if (count <= 0) break;
				rows.push(...wrapped.slice(0, count));
				usedRows += count;
				if (count < wrapped.length) break; // A partially visible source line is hidden.
				visibleLines++;
			}
			if (!expanded && body.length > visibleLines) {
				const hidden = body.length - visibleLines;
				rows.push(...wrap(styleHint(`... (${hidden} more ${hidden === 1 ? "line" : "lines"} • ${expandHint()})`)));
			}
			for (const footer of footers) rows.push(...wrap(footer));
			return rows;
		},
		invalidate() {},
	};
}

export function renderCall(
	args: DisplayArgs,
	theme: Theme,
	context: ToolRenderContext,
) {
	// Arguments can arrive incrementally; rendering must not require a valid call.
	const argv = [
		typeof args?.executable === "string" ? argument(args.executable) : "…",
		...(Array.isArray(args?.args)
			? args.args.map((value) => typeof value === "string" ? argument(value) : "…")
			: []),
	].join(" ");
	const override = typeof args?.cwd === "string";
	const cwd = override ? args.cwd! : context.cwd;
	const call = display(
		[],
		[theme.fg("toolTitle", theme.bold("sudo_exec")) + " " + theme.fg("accent", argv)], [], context.expanded, 4,
		(hint) => theme.fg("muted", hint),
	);
	const location = (override && cwd !== context.cwd) || context.expanded
		? display([], [theme.fg("muted", `cwd: ${argument(cwd)}`)], [], context.expanded, 4,
			(hint) => theme.fg("muted", hint))
		: undefined;
	return {
		render(width: number) {
			return [
				...call.render(width),
				...(location?.render(width) ?? []),
				...(context.expanded ? display([theme.fg("muted", "argv display only · not a shell command; do not copy as a shell command")], [], [], true).render(width) : []),
			];
		},
		invalidate() {},
	};
}

interface ResultDetails {
	code?: number | null;
	cancelled?: boolean;
	timedOut?: boolean;
	truncated?: boolean;
}

function outcomeBody(text: string, details: ResultDetails | undefined, isError: boolean) {
	const match = OUTCOME_HEADER.exec(text);
	if (!match) return { body: text, truncated: details?.truncated === true };
	const [, code, cancelled, timedOut, truncated] = match;
	// Error results are thrown (and have no details); successful results retain
	// details. Only strip the exact generated header, never a loose `exit=` line.
	if (!isError && (!details || details.code !== (code === "null" ? null : Number(code)) ||
		details.cancelled !== (cancelled === "true") || details.timedOut !== (timedOut === "true") ||
		details.truncated !== (truncated === "true")))
		return { body: text, truncated: details?.truncated === true };
	return { body: text.slice(match[0].length), truncated: truncated === "true" || details?.truncated === true };
}

function resultStatus(isError: boolean, cancelled: boolean, timedOut: boolean, code: number | null | undefined): string {
	if (isError) {
		if (cancelled) return "Error · Cancelled";
		if (timedOut) return "Error · Timed out";
		return code == null ? "Error" : `Error · exit=${code}`;
	}
	if (cancelled) return "Cancelled";
	if (timedOut) return "Timed out";
	if (code == null) return "Result (status unknown)";
	return code === 0 ? "Completed · exit=0" : `Failed · exit=${code}`;
}

export function renderResult(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: ToolRenderContext,
) {
	if (options.isPartial) return display([theme.fg("warning", "Running…")], [], [], true);
	const details = result.details && typeof result.details === "object" ? result.details as ResultDetails : undefined;
	const text = result.content.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text).join("\n");
	const parsed = outcomeBody(text, details, context.isError);
	const matched = parsed.body !== text ? OUTCOME_HEADER.exec(text) : null;
	const cancelled = details?.cancelled === true || matched?.[2] === "true";
	const timedOut = details?.timedOut === true || matched?.[3] === "true";
	let code = details?.code;
	if (code === undefined && matched)
		code = matched[1] === "null" ? null : Number(matched[1]);
	const status = resultStatus(context.isError, cancelled, timedOut, code);
	let color: "error" | "warning" | "success" | "muted" = "muted";
	if (context.isError || (code != null && code !== 0)) color = "error";
	else if (cancelled || timedOut) color = "warning";
	else if (code === 0) color = "success";
	let body = parsed.body;
	let cleanup = false;
	if (body.startsWith(`${CLEANUP_WARNING}\n`) && body !== text) {
		body = body.slice(CLEANUP_WARNING.length + 1);
		cleanup = true;
	}
	const header = [theme.fg(color, status)];
	// Thrown errors carry no structured provenance. Keep the original header as
	// diagnostic evidence even when its exact format supplies a status summary.
	if (context.isError && !details && matched) header.push(theme.fg("muted", safeText(matched[0].trimEnd())));
	if (cleanup) header.push(theme.fg("warning", CLEANUP_WARNING));
	const footers = parsed.truncated ? [theme.fg("warning", "[Output truncated during capture · expanding will not show missing output]")] : [];
	return display(body ? [...header, ""] : header, body ? safeText(body).split("\n").map((line) => theme.fg("toolOutput", line)) : [], footers, options.expanded, PREVIEW_ROWS, (hint) => theme.fg("muted", hint));
}
