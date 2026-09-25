# Changelog

## Unreleased

- Add explicit TUI-only OS askpass unlock with root-owned canonical helper checks and auth-only environment/ignored streams. Terminal authentication remains default.
- Revoke logical grants before lock cleanup despite host failures, normalize late aborted executions, and preserve original outcomes with cleanup warnings.
- Bound final model-facing UTF-8 output including status and cleanup diagnostics. Clarify that sudo_exec, not ordinary bash, uses the grant.
- Show sudo_exec argv, cwd, progress and results in expandable tool cards; escape terminal controls without changing execution arguments.
