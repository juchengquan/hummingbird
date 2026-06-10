'use client';

import type { Path, TElement, Value } from 'platejs';

import { CopilotPlugin } from '@platejs/ai/react';
import { serializeMd, stripMarkdown } from '@platejs/markdown';

import { apiUrls } from '@/client/api-client';
import { useStore } from '@/client/hooks/use-store';
import { GhostText } from '@/components/ui/ghost-text';
import {
  COMPLETE_PREFIX_MAX,
  type CompleteRequestInput,
} from '@/shared/api-schemas';

import { MarkdownKit } from './markdown-kit';

/**
 * Plate Copilot plugin wired to `/api/ai/complete`. Reads
 * `editorPrefs.inlineComplete` synchronously per trigger so the
 * settings toggle takes effect without re-creating the editor.
 *
 * Wire shape ↔ `CompleteRequestSchema`: we transport
 * `{ prefix, blockText, model? }` via a custom `fetch` that rewrites
 * the body Plate's default `useCompletion` would send (which has the
 * structured payload encoded in `prompt`). The server's prompt
 * builder runs there, not here, so the LLM-facing prompt template
 * stays one source of truth.
 *
 * Sequencing decisions (`docs/PLAN-inline-autocomplete.md`):
 * - `debounceDelay: 400` — match the plan's pinned latency budget.
 *   Plate's default of 0 would fire on every keystroke; 400ms is
 *   the "user paused" signal.
 * - `triggerQuery` returns `false` when the toggle is off →
 *   ambient ghost text is opt-in.
 * - Cap the preceding-document prefix to the schema's pre-prompt
 *   cap (the trailing slice — the bit closest to the cursor).
 */

/** Serialise everything before the cursor's current block into a
 *  bounded markdown prefix. Plate exposes `editor.children` as the
 *  whole document tree and `path` indices into it; "everything before
 *  the current block" is the children sliced at the top-level index
 *  of the current block's path. Multi-paragraph documents commonly
 *  exceed our cap, so we keep only the trailing window (the bit the
 *  model needs to predict the next token). */
function buildPrefixMarkdown(
  // The editor instance the CopilotPlugin hands us. Typed loosely
  // because we only touch the public Slate surface used here, and a
  // tighter typing would couple this helper to the kit composition.
  editor: {
    children: Value;
    api: { block: (options: { highest: true }) => [TElement, Path] | undefined };
  }
): string {
  const blockEntry = editor.api.block({ highest: true });
  if (!blockEntry) return '';
  const blockIndex = blockEntry[1][0];
  if (!Number.isFinite(blockIndex) || blockIndex <= 0) return '';
  const preceding = editor.children.slice(0, blockIndex) as TElement[];
  if (preceding.length === 0) return '';
  // serializeMd takes the same `editor` it was constructed against;
  // it serialises whatever subset of nodes we pass in `value`.
  const md = serializeMd(editor as never, { value: preceding });
  if (md.length <= COMPLETE_PREFIX_MAX) return md;
  return md.slice(md.length - COMPLETE_PREFIX_MAX);
}

export const CopilotKit = [
  ...MarkdownKit,
  CopilotPlugin.configure(({ api }) => ({
    options: {
      completeOptions: {
        api: apiUrls.aiComplete(),
        // Custom fetch: rewrite Plate's default
        // `{ prompt, ...body }` POST body into our
        // `{ prefix, blockText, model? }` schema before forwarding to
        // the route. Plate puts our serialised payload into `prompt`
        // (see `getPrompt` below); we just unwrap it here.
        fetch: ((input, init) => {
          try {
            const raw = init?.body;
            const parsed =
              typeof raw === 'string'
                ? (JSON.parse(raw) as { prompt?: string })
                : null;
            const payloadString = parsed?.prompt;
            if (payloadString) {
              const payload = JSON.parse(payloadString) as CompleteRequestInput;
              return fetch(input, {
                ...init,
                body: JSON.stringify(payload),
              });
            }
          } catch {
            // Fall through to the unmodified POST — the route will
            // reject as invalid and the plugin's onError handler
            // suppresses it. Never crash the editor on a transform
            // failure.
          }
          return fetch(input, init);
        }) as typeof fetch,
        onError: () => {
          // Swallow — the user is typing; a transient route failure
          // should never surface as a toast or error block. Plate's
          // ghost-text simply doesn't appear this round.
        },
        onFinish: (_prompt, completion) => {
          if (!completion || completion === '0') return;
          const text = stripMarkdown(completion).trim();
          if (!text) return;
          api.copilot.setBlockSuggestion({ text });
        },
      },
      debounceDelay: 400,
      renderGhostText: GhostText,
      // Honour the per-user toggle. Read synchronously from the
      // store on each trigger — Plate runs this on every typing-pause
      // candidate, so a flip in settings takes effect immediately.
      triggerQuery: () => {
        try {
          return useStore.getState().editorPrefs.inlineComplete === true;
        } catch {
          return false;
        }
      },
      getPrompt: ({ editor }) => {
        const blockEntry = editor.api.block({ highest: true });
        if (!blockEntry) return '';
        const blockText = serializeMd(editor, {
          value: [blockEntry[0] as TElement],
        });
        const prefix = buildPrefixMarkdown(
          editor as unknown as Parameters<typeof buildPrefixMarkdown>[0]
        );
        const payload: CompleteRequestInput = {
          blockText,
          ...(prefix ? { prefix } : {}),
        };
        // The string we return becomes `body.prompt`; the custom
        // fetch above unwraps it into the route's schema shape.
        return JSON.stringify(payload);
      },
    },
    shortcuts: {
      accept: {
        keys: 'tab',
      },
      acceptNextWord: {
        keys: 'mod+right',
      },
      reject: {
        keys: 'escape',
      },
      triggerSuggestion: {
        keys: 'ctrl+space',
      },
    },
  })),
];
