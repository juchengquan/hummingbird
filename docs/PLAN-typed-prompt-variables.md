# Plan: Typed prompt variables (deferred — likely over-engineering)

Status: **deferred** — do not build unless users explicitly ask.

Let prompt authors annotate `{variable}` markers with a type hint so the
fill-in modal renders a richer input: steppers for numbers, dropdowns for
enums. Currently every variable gets a plain text `<Input>` regardless
of intent.

## ⚠️ Is this even a problem?

Today's plain-text-everywhere model handles the 90%+ use case fine. The
few examples that surface in practice:

| Template | Current UX | Hypothetical typed UX |
|---|---|---|
| `Summarize in {char_count} words` | Text input. User types `500`. | Number stepper, bounded 1–1000. |
| `Reply in a {tone} tone.` | Text input. User types `friendly`. | Dropdown: formal, casual, friendly, sarcastic, professional. |
| `Generate {count} variations.` | Text input. User types `3`. | Number stepper, 1–5. |

For each case the text input works. The improvement is marginal — a click
or two saved — at the cost of a new syntax users must learn.

## Proposed syntax (if we ever build this)

```
{age: int 1 120}
{char_count: int 1 1000}
{tone: enum formal casual friendly sarcastic professional}
{name}                                    ← default: plain text
```

Colon-separated type spec inside the braces. Parser splits on `:`,
trims, first token is the type:

| Type | Args | UI |
|---|---|---|
| `int` | `min max` | `number` input with stepper, clamped |
| `enum` | `choices...` | `<select>` dropdown |
| *(none)* | *(default)* | Text input (current behavior) |

`parseTemplate` and `expandTemplate` already produce variable names
independently — they'd additionally extract the type metadata as an
optional `annotation` field on each segment / variable entry.

## Why this is likely over-engineering

| Concern | Detail |
|---|---|
| **Syntax creep** | `{name}` is obvious and requires zero learning. `{age: int 1 120}` is a DSL. Most users won't use it, and the ones who try will be confused by the colon escaping rules. |
| **Escape complexity** | `{` maps to variable, `{{` to literal `{`. Introduce `:` as a special char and you need rules for literal colons in names: `namespace\:value`. The spec doubles in size for a feature almost nobody needs. |
| **Wrong product surface** | Typed inputs, steppers, and dropdowns turn the prompt library into a form builder. If the product ever needs that, it should be its own surface (a "template builder") — not bolted into the prompt-variable syntax. |
| **The AI doesn't care** | After substitution the AI receives a string regardless. `500` from a stepper and `"500"` from a text field are identical to the model. The type is a human-facing affordance only. |
| **Low demand signal** | No user feedback requesting typed variables exists yet. Building it before the ask ships complexity nobody asked for. |
| **The template text already communicates intent** | A prompt author writes `Summarize in {char_count} words`. Anyone filling it in reads "char_count" and understands it's a number. The AI reads the expanded `"500"` and treats it as text — the word "words" after the variable does the semantic work. |

## What would a real version look like

About half a day of work if ever greenlit:

### Phase 1 — Annotated parse (`expand.ts`)
- `{name}` stays unchanged (plain text).
- `{name: int 1 10}` parses to `{ name, annotation: { kind: "int", min: 1, max: 10 } }`.
- `{name: enum a b c}` parses to `{ name, annotation: { kind: "enum", choices: ["a","b","c"] } }`.
- Unknown type or malformed annotation → treat as plain text.

### Phase 2 — Fill-in modal (`prompt-variable-fill.tsx`)
- Read annotation, render `Input` / `<select>` / number stepper accordingly.
- Validate on submit (number clamped, empty select prevented).

## Decision

**Defer.** If a user explicitly requests typed-prompt-variable inputs,
revisit this plan. Until then, the plain-text `{variable}` pattern is
the right level of complexity for a chat prompt library.
