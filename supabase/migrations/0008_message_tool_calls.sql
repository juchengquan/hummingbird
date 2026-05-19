-- Durable per-message record of tool invocations.
--
-- Each message can include zero or more tool calls — web searches, image
-- generations, code executions, etc. Stored as JSONB so adding new tool
-- kinds doesn't need a schema change. The shape is small (a handful of
-- string fields per entry) and the size is bounded by stopWhen (default
-- stepCountIs(5)) in the chat route.
--
-- Previously the chat route appended a markdown footer to the message
-- content to preserve a record across reload — that polluted Copy /
-- Export output and only rendered as plain text. This column lets the
-- client re-render the same pretty pill from `<ToolCallStrip>` after a
-- reload without mixing the record into the message body.

alter table messages
  add column if not exists tool_calls jsonb;
