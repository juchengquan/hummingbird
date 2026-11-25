"""The code interpreter's sandbox (wave 8, Q92): a port of Next's
`lib/server/code-sandbox/`, embedding microsandbox's Python SDK as Next
embeds the Node one (`docs/TRIAL-code-interpreter-on-agent-py.md`).

| Module | What |
|---|---|
| `types` | `CodeRunInput` / `CodeRunResult` / `CodeFile`, the `CodeSandbox` protocol |
| `config` | `SandboxLimits` from the `CODE_SANDBOX_*` settings; `is_enabled` |
| `marshal` | the raw run → `CodeRunResult` (caps, tables, notes); pure |
| `mount_files` | model-named files → guest paths and bytes, by the run's manifest; pure but for the injected download |
| `mime` | an output file's MIME type by its extension |
| `microsandbox_sandbox` | boot, mount, exec, read back, stop; one process-wide slot limit |
| `select` | the startup check: a sandbox, or None and `runCode` is absent |
"""
