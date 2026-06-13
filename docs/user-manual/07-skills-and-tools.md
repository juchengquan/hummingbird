<!-- pages-for: skill:webFetch, skill:webSearch, skill:imageGen, skill:searchFiles, panel:skills-tab -->
<!-- related: lib/shared/skills/registry.ts, lib/shared/skills/, components/panels/skills-tab.tsx -->

# Skills & tools

## What it is
Skills are capabilities the model can opt into for a single turn
(`/search ...`) or always-on for a session (the toggle in the
**Skills** right-rail tab). Tools are the underlying function calls;
the skill is the user-facing wrapper.

## How to open it
- The **Skills** tab in the right rail lists every skill and its
  toggle state.
- The **Skills** entry in the left sidebar opens the same list.
- Trigger a skill per-turn with its slash trigger (see
  [Slash commands](06-slash-commands.md)).

## What you can do
- **Web fetch** (`/fetch`) - point the model at a URL and have it
  read the page. No API key required.
- **Web search** (`/search`) - search the web. Backed by Tavily,
  Brave, and/or Exa, depending on which keys the self-hoster has
  enabled.
- **Image generation** (`/image`) - generate an image from a prompt
  (or a prompt + a reference image URL). Backed by Minimax.
- **File search** (`/files`) - let the model pull additional sections
  from your attached files when the inline view was truncated.

## Tips & gotchas
- Each skill has a per-turn cap (visible in the Skills tab) to stop
  runaway costs. The cap is shared across all enabled web providers
  in a single search.
- Some skills require sign-in. File search, for example, reads
  Supabase-stored full text via an RLS-scoped RPC.
- Skills show as chips above the chat input. A green chip is on for
  the next turn; a faded chip is off.

## Related
- [Slash commands](06-slash-commands.md)
- [MCP servers](24-mcp-server-config.md)
