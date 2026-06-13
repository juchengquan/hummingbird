<!-- pages-for: slash:new, slash:clear, slash:rename, slash:model, slash:help, slash:personas, skill:webFetch, skill:webSearch, skill:imageGen, skill:searchFiles, panel:slash-autocomplete, panel:slash-help-dialog, panel:agents-dialog -->
<!-- related: lib/shared/commands/registry.ts, lib/shared/skills/registry.ts, lib/shared/skills/slash-parser.ts -->

# Slash commands

## What it is
The `/` menu inside the chat input. It has two kinds of entries:
**commands** (run-now actions that don't send a message) and
**skill triggers** (force a skill on for the next turn and then send).

## How to open it
Type `/` in the chat input. The autocomplete menu appears. Keep typing
to filter, or use arrow keys + Enter to pick.

## Commands (run-now)

| Command | What it does |
|---|---|
| `/new` | Start a fresh chat in the current workspace. |
| `/clear` | Remove every message in the current chat. Asks for confirmation. |
| `/rename <title>` | Set the current chat's title. |
| `/model [name]` | Switch the model. With a name, switches immediately; with no name, opens the picker. |
| `/help` or `/?` | Open the slash & mention help dialog. |
| `/personas` or `/agents` | Manage custom AI personas. |

## Skill triggers (send-and-skill)

| Trigger | Skill |
|---|---|
| `/fetch` or `/f` | Fetch a specific URL and read its contents. |
| `/search` or `/s` | Web search (Tavily / Brave / Exa, depending on what's enabled). |
| `/image` or `/img` | Image generation. |
| `/files` or `/file` | Pull additional sections from your attached files via full-text search. |

A skill trigger turns the skill on for the next turn, then sends the
message. Type the trigger first, then a space, then the rest of your
message.

## Tips & gotchas
- Command triggers don't require a trailing space: `/clear` on its
  own is valid. Skill triggers do - `/search` alone does nothing,
  but `/search what is ...` sends a web-search turn.
- The full help dialog (slash-help-dialog) is the same data this
  page describes; you can always read it in-app via `/help`.

## Related
- [Chat](02-chat.md)
- [Skills & tools](07-skills-and-tools.md)
