<!-- pages-for: panel:chat, slash:new, slash:clear, slash:rename, slash:model, slash:help, slash:personas -->
<!-- related: components/panels/chat.tsx, lib/shared/commands/registry.ts, lib/shared/skills/registry.ts -->

# Chat

## What it is
The main conversation surface. You send messages; the model streams a
reply. Attachments, slash commands, and skills are all available from
the chat input.

## How to open it
Click any conversation in the **Chats** section of the left sidebar,
or click the **+** next to the **Chats** group to start a new one.

## What you can do
- Type a message and press **Enter** to send. **Shift+Enter** inserts
  a newline without sending.
- Drag a file onto the input to attach it to the conversation.
- Use `/` to open the slash-command menu: type `/` and pick from the
  list, or keep typing to filter.
- Use `#` to mention a file, bookmark, or other resource from your
  workspace. The mention is auto-attached to the message.
- Hover an assistant message to see the **archive** and **bookmark**
  actions.
- Switch the model on the fly with `/model <name>`. With no name it
  opens the picker.

## Tips & gotchas
- Streaming tokens render as they arrive - long replies can be
  cancelled by hitting Esc or sending another message.
- The reasoning panel (when present) is collapsible. Reasoning tokens
  are not shown by default on all models.
- Some skills (web search, image generation) require their own API
  keys in the deployment's `.env`. If a skill toggle is greyed out,
  ask the self-hoster to enable the key.
- Switching the chat backend (Next.js vs. the Python agent service)
  is a power-user setting - see [Settings & theme](12-settings-and-theme.md).

## Related
- [Slash commands](06-slash-commands.md)
- [Files & attachments](04-files-and-attachments.md)
- [Settings & theme](12-settings-and-theme.md)
