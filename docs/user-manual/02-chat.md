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
- A persona that limits its MCP servers (`/personas`) limits them in
  its replies and tasks (Next.js and agent-py (runs) backends): only the
  servers it allows offer tools, and one that allows none uses no MCP
  tools at all. Local-mode servers count too: tick them in the persona
  to use them in chat (tasks can't use local-mode servers).
- Switching the chat backend (Next.js vs. the Python agent service)
  is a power-user setting - see [Settings & theme](12-settings-and-theme.md).
- **Questions from the assistant (agent-py (runs) backend).** When the
  assistant needs you mid-answer - approve a tool call, pick an option,
  type an answer, or fill in an interactive card (confirm, form, date
  picker) - the reply pauses and answer cards appear under it, the same
  cards the [task strip](08-agent-tasks.md) uses. Answer them and the
  same reply continues: the cards go away as soon as the assistant picks
  your answer up, and an interactive card you answered stays in the reply
  showing what you picked (also after a reload). With several questions,
  the answers are sent together once all are answered (**Change** edits
  one before that).
  Sending a new message instead skips the question. The cards survive a
  reload. A question that has expired can only be dismissed; if the
  answer comes too late for the server, **Resend message** asks again
  from your original message. If another tab or device already answered,
  the card says so and can be dismissed.

## Related
- [Slash commands](06-slash-commands.md)
- [Files & attachments](04-files-and-attachments.md)
- [Settings & theme](12-settings-and-theme.md)
