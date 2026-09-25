# pi-sudo

This public Git-hosted Pi extension (npm publishing disabled via `private: true`) registers `/sudo` and `sudo_exec` from root `index.ts` (`package.json` → `pi.extensions`). Do not move the entrypoint. Human-facing docs are Korean; this agent-facing file is English.

- `index.ts` owns host/TTY gating, confirmation, TUI restoration, pending-confirmation epochs and shutdown. `touched` is not authorization; `src/sudo.ts` owns the grant.
- `src/sudo.ts` owns serialized authorization and execution, generation/revocation, deadlines, and fail-closed invalidation. Keep separate `sudo -k`, interactive `sudo -v`, and `sudo -n -- /usr/bin/true` probe. Invalidate logical access before awaiting cache cleanup.
- `src/process.ts` owns direct, non-detached child lifecycle and bounded output. Do not claim descendants are guaranteed to terminate or that sudo cache is isolated from same-UID/TTY processes.
- Keep `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` exact `0.87.1` development versions unless explicitly assigned to change them. Do not add sudoers/install/configuration side effects.

- Keep comments focused on ownership, ordering, and failure invariants rather than paraphrasing statements. Do not split modules solely to match another package.
- Mermaid sources in `docs/diagram/*.mmd` are canonical. Run `bun run docs:render` after changing them to regenerate SVG/2x PNG and Markdown via pinned rootless Podman; `docs:diagrams` only syncs Markdown. Do not hand-edit generated blocks or assets. Preserve the renderer's network, mount and privilege restrictions.

From this directory, run `bun run check`, `bun test`, and `bun run docs:check`; there is no `ci` or `lint` script. Tests use fake sudo and unprivileged subprocesses, not real sudo authentication. See [`docs/development.md`](docs/development.md), [`docs/security.md`](docs/security.md), and [`docs/architecture.md`](docs/architecture.md).
