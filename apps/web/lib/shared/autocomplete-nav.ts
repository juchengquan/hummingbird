/**
 * Pure keyboard-navigation reducer shared by the chat input's two
 * autocomplete surfaces — the `/` slash menu and the `@` prompt-mention
 * menu. Both answer the same four keys identically: Arrow down/up move
 * the highlight (wrapping at the ends), Enter/Tab pick the active row,
 * Escape dismisses the menu. The branch logic lived inline twice in
 * `chat.tsx`'s `handleKeyDown`; centralising it here keeps the two
 * autocomplete hooks in lock-step and makes the navigation unit-testable
 * without a React renderer.
 *
 * Any other key (and an empty menu) is `passthrough` — the caller should
 * not `preventDefault`, letting the keystroke reach the textarea / send.
 */
export type AutocompleteNav =
  | { kind: "move"; index: number }
  | { kind: "pick" }
  | { kind: "dismiss" }
  | { kind: "passthrough" }

export function navigateAutocomplete(
  key: string,
  count: number,
  activeIndex: number
): AutocompleteNav {
  if (count <= 0) return { kind: "passthrough" }
  switch (key) {
    case "ArrowDown":
      return { kind: "move", index: (activeIndex + 1) % count }
    case "ArrowUp":
      return { kind: "move", index: (activeIndex - 1 + count) % count }
    case "Enter":
    case "Tab":
      return { kind: "pick" }
    case "Escape":
      return { kind: "dismiss" }
    default:
      return { kind: "passthrough" }
  }
}
