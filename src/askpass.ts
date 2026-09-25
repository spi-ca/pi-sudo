import { realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute } from "node:path";

type Files = { realpath(path: string): string; stat(path: string): Stats };
const files: Files = { realpath: realpathSync, stat: statSync };

/** Only canonical, system-owned paths are trusted; symlink targets and every ancestor count. */
export function trustedAskpass(
	value: string | undefined,
	fs: Files = files,
): string {
	if (!value || !isAbsolute(value) || value.includes("\0"))
		throw new Error("SUDO_ASKPASS must name an absolute trusted system helper");
	let path: string;
	try {
		path = fs.realpath(value);
		let current = path;
		let helper = true;
		while (true) {
			const stat = fs.stat(current);
			if (
				stat.uid !== 0 ||
				(stat.mode & 0o022) !== 0 ||
				(helper && (!stat.isFile() || (stat.mode & 0o111) === 0)) ||
				(!helper && !stat.isDirectory())
			)
				throw new Error("untrusted ownership, permissions or file type");
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
			helper = false;
		}
	} catch {
		throw new Error(
			"SUDO_ASKPASS helper and canonical ancestors must be root-owned, non-writable by group/others; helper must be a regular executable",
		);
	}
	return path;
}
