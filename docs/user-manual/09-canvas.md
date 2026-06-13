<!-- pages-for: panel:canvas -->
<!-- related: components/panels/canvas.tsx -->

# Canvas

## What it is
A free-form canvas where each node is a conversation (or a fork of
one). Useful for branching a chat into parallel investigations, or
for laying out the shape of a multi-step project.

## How to open it
The **Canvas** entry in the left sidebar. If a workspace has no
canvas yet, you'll see an empty state with a button to create one.

## What you can do
- Drag from any conversation node to create a fork - the new node
  is a child conversation that starts from the parent's history.
- Pan with click-and-drag on the background. Zoom with trackpad /
  mouse wheel.
- Connect nodes by dragging from a node's handle to another node.
- Delete a node with the **Delete** key when it's selected.

## Tips & gotchas
- A forked conversation is a real conversation - it appears in the
  Chats sidebar, it counts against your storage, and it can be
  renamed, pinned, and deleted like any other.
- The canvas layout is per-workspace.

## Related
- [Conversations & workspaces](05-conversations-and-workspaces.md)
- [Chat](02-chat.md)
