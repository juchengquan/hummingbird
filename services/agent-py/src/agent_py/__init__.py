"""Hummingbird agent service — Python implementation.

Phase 0 (PLAN-agent-api.md): scaffolding only. The service boots, authenticates
incoming Supabase JWTs, and exposes health endpoints. No agent logic, no
production traffic. Phase 1 adds the read-only `task_jobs` queue replica.
"""

__version__ = "0.1.0"
