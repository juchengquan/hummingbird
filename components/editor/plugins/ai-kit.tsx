'use client';

import { withAIBatch } from '@platejs/ai';
import {
  AIChatPlugin,
  AIPlugin,
  applyAISuggestions,
  streamInsertChunk,
  useChatChunk,
} from '@platejs/ai/react';
import { getPluginType, KEYS, PathApi } from 'platejs';
import { usePluginOption } from 'platejs/react';

import { AILoadingBar, AIMenu } from '@/components/ui/ai-menu';
import { AIReviewKeymap } from '@/components/editor/ai-review-keymap';
import { AIReviewPill } from '@/components/editor/ai-review-pill';
import { apiUrls } from '@/client/api-client';
import { useStore } from '@/client/hooks/use-store';
import { AIAnchorElement, AILeaf } from '@/components/ui/ai-node';

import { useChat } from '../use-chat';
import { CursorOverlayKit } from './cursor-overlay-kit';
import { MarkdownKit } from './markdown-kit';

export const aiChatPlugin = AIChatPlugin.extend({
  options: {
    chatOptions: {
      api: apiUrls.aiCommand(),
      body: {},
    },
  },
  render: {
    afterContainer: AIChatAfterContainer,
    afterEditable: AIMenu,
    node: AIAnchorElement,
  },
  shortcuts: { show: { keys: 'mod+j' } },
  useHooks: ({ editor, getOption }) => {
    useChat();

    const mode = usePluginOption(AIChatPlugin, 'mode');
    const toolName = usePluginOption(AIChatPlugin, 'toolName');
    useChatChunk({
      onChunk: ({ chunk, isFirst, nodes, text: content }) => {
        if (isFirst && mode === 'insert') {
          editor.tf.withoutSaving(() => {
            editor.tf.insertNodes(
              {
                children: [{ text: '' }],
                type: getPluginType(editor, KEYS.aiChat),
              },
              {
                at: PathApi.next(editor.selection!.focus.path.slice(0, 1)),
              }
            );
          });
          editor.setOption(AIChatPlugin, 'streaming', true);
        }

        if (mode === 'insert' && nodes.length > 0) {
          withAIBatch(
            editor,
            () => {
              if (!getOption('streaming')) return;
              editor.tf.withScrolling(() => {
                streamInsertChunk(editor, chunk, {
                  textProps: {
                    [getPluginType(editor, KEYS.ai)]: true,
                  },
                });
              });
            },
            { split: isFirst }
          );
        }

        if (toolName === 'edit' && mode === 'chat') {
          withAIBatch(
            editor,
            () => {
              applyAISuggestions(editor, content);
            },
            {
              split: isFirst,
            }
          );
        }
      },
      onFinish: () => {
        editor.setOption(AIChatPlugin, 'streaming', false);
        editor.setOption(AIChatPlugin, '_blockChunks', '');
        editor.setOption(AIChatPlugin, '_blockPath', null);
        editor.setOption(AIChatPlugin, '_mdxName', null);

        // "Review changes" toggle off → auto-accept every suggestion
        // the AI just produced. Same as today's blast-replace UX, but
        // routed through Plate's accept transform so the document
        // ends in a clean state (no stray suggestion marks). Toggle
        // ON (default) leaves the suggestions pending; the review
        // pill + BlockSuggestion card take over.
        if (toolName === 'edit' && mode === 'chat') {
          const review = useStore.getState().editorPrefs.aiReviewChanges;
          if (!review) {
            editor.getTransforms(AIChatPlugin).aiChat.accept();
          }
        }
      },
    });
  },
});

/** Composite `afterContainer` renderer that hosts both the
 *  streaming loading bar AND the post-finish review surfaces
 *  (pill + keymap). Plate's `render.afterContainer` slot only
 *  accepts a single component, so we wrap. */
function AIChatAfterContainer() {
  return (
    <>
      <AILoadingBar />
      <AIReviewPill />
      <AIReviewKeymap />
    </>
  );
}

export const AIKit = [
  ...CursorOverlayKit,
  ...MarkdownKit,
  AIPlugin.withComponent(AILeaf),
  aiChatPlugin,
];
