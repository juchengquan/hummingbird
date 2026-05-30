"""Model-provider step-fn factories.

Each module here builds a `RunStepFn` that the executor's runner can
consume. Phase 2b ships the first one — Anthropic, text-only (no
tools). Subsequent phases:

  - Phase 2b-2 — tool registry + the first three tools (webFetch,
    webSearch, searchFiles).
  - Phase 3 — MCP parity + per-step pendingInput plumbing.
  - Future — OpenAI / Gemini / Minimax-CN providers if needed.

The factory pattern keeps the provider SDK off the runner's import
path; the runner only sees a `RunStepFn`. Tests inject a fake step fn
without touching real HTTP.
"""
