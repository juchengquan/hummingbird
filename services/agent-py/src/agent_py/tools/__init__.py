"""Agent tools — registry + first implementations.

Phase 2b-2 of PLAN-agent-api. Port of `lib/server/skills/registry.ts`,
narrowed to the bits the Python executor needs at runtime: a
descriptor that bundles the Anthropic-wire-format JSON schema with an
async invocation function. `default_tool_registry()` returns the
process-wide set (just `webFetch` today; `webSearch` + `searchFiles`
slot in alongside in later phases).

The descriptor shape is intentionally close to Anthropic's tool wire
format — `name`, `description`, `input_schema` are exactly what the
SDK expects when listed in `messages.stream(tools=[...])`. `execute`
is what we call ourselves after the model emits a `tool_use` block;
the SDK doesn't invoke tools for us.
"""

from .registry import (
    ToolContext,
    ToolDescriptor,
    ToolError,
    ToolInvocationResult,
    default_tool_registry,
    tool_to_anthropic_param,
)

__all__ = [
    "ToolContext",
    "ToolDescriptor",
    "ToolError",
    "ToolInvocationResult",
    "default_tool_registry",
    "tool_to_anthropic_param",
]
