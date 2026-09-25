/** Render only checked-in diagram sources in an offline, rootless Podman container. */
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Existing image tag 11.4.3 reports mmdc 11.4.2. The digest, not the tag, pins the content.
const image =
	"ghcr.io/mermaid-js/mermaid-cli/mermaid-cli@sha256:01c60f8b1f5ff4e5633aa6a527f399baabf2443f181db28cdaa8d2967bf65e46";
const directory = fileURLToPath(new URL("../docs/diagram", import.meta.url));
const names = ["modules", "auth-exec", "grant-lifecycle"];
const probe = spawnSync(
	"podman",
	["info", "--format", "{{.Host.Security.Rootless}}"],
	{ encoding: "utf8" },
);
if (probe.error || probe.status !== 0 || probe.stdout.trim() !== "true") {
	throw new Error(
		"Rootless Podman is required. Do not run this script with sudo.",
		{ cause: probe.error },
	);
}
if (process.getuid?.() === undefined || process.getgid?.() === undefined) {
	throw new Error(
		"Rendering requires a Unix host with UID/GID mapping support.",
	);
}
const output = await mkdtemp(join(tmpdir(), "pi-sudo-diagrams-"));
try {
	for (const name of names) {
		for (const extension of ["svg", "png"]) {
			const result = spawnSync(
				"podman",
				[
					"run",
					"--rm",
					"--pull=never",
					"--network=none",
					"--cap-drop=all",
					"--security-opt=no-new-privileges",
					"--read-only",
					"--tmpfs",
					"/tmp:rw,nosuid,nodev,size=256m",
					"--env",
					"HOME=/tmp",
					"--userns=keep-id",
					"--user",
					`${process.getuid!()}:${process.getgid!()}`,
					"--volume",
					`${directory}:/input:ro`,
					"--volume",
					`${output}:/output:rw`,
					image,
					"-i",
					`/input/${name}.mmd`,
					"-o",
					`/output/${name}.${extension}`,
					"-b",
					"white",
					"-w",
					"1800",
					"-s",
					"2",
				],
				{ stdio: "inherit" },
			);
			if (result.error || result.status !== 0) {
				throw new Error(
					`Rendering failed: ${name}.${extension}. Ensure the pinned image is available locally.`,
					{ cause: result.error },
				);
			}
		}
	}
	// Do not replace existing assets when any of the six renders failed.
	for (const name of names) {
		for (const extension of ["svg", "png"]) {
			await copyFile(
				join(output, `${name}.${extension}`),
				join(directory, `${name}.${extension}`),
			);
		}
	}
	console.log("Rendered 3 SVG and 3 PNG diagrams (PNG scale 2).");
} finally {
	await rm(output, { recursive: true, force: true });
}
