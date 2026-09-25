import type { Outcome } from "./process.js";

const MAX_BYTES = 48 * 1024;
const MAX_LINES = 2000;

/** Limit the final UTF-8 text, not the raw pipe bytes (replacement chars can expand). */
export function boundedText(
	parts: string[],
	maxBytes = MAX_BYTES,
): { text: string; truncated: boolean } {
	let bytes = 0;
	let lines = 1;
	let text = "";
	for (const part of parts) {
		for (const char of part) {
			const size = Buffer.byteLength(char, "utf8");
			if (bytes + size > maxBytes || (char === "\n" && lines >= MAX_LINES))
				return { text, truncated: true };
			text += char;
			bytes += size;
			if (char === "\n") lines++;
		}
	}
	return { text, truncated: false };
}

export function boundedError(error: unknown): string {
	const message = String(error);
	const first = boundedText([message]);
	if (!first.truncated) return first.text;
	const suffix = " [truncated]";
	return (
		boundedText([message], MAX_BYTES - Buffer.byteLength(suffix)).text + suffix
	);
}

export function formatOutcome(result: Outcome): {
	text: string;
	truncated: boolean;
} {
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	const warning = result.cleanupWarning ? `${result.cleanupWarning}\n` : "";
	const header = (truncated: boolean) =>
		`exit=${result.code}, cancelled=${result.cancelled}, timedOut=${result.timedOut}, truncated=${truncated}\n`;
	let bounded = boundedText([header(true), warning, output]);
	const truncated = result.truncated || bounded.truncated;
	if (!truncated) bounded = boundedText([header(false), warning, output]);
	return { text: bounded.text, truncated };
}
