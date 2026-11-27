'use client';

import * as React from 'react';

import { type UseChatHelpers, useChat as useBaseChat } from '@ai-sdk/react';
import {
  AIChatPlugin,
  aiCommentToRange,
  applyTableCellSuggestion,
} from '@platejs/ai/react';
import { getCommentKey, getTransientCommentKey } from '@platejs/comment';
import { deserializeMd } from '@platejs/markdown';
import { BlockSelectionPlugin } from '@platejs/selection/react';
import { type UIMessage, DefaultChatTransport } from 'ai';
import { type TNode, KEYS, nanoid, NodeApi, TextApi } from 'platejs';
import { useEditorRef, usePluginOption } from 'platejs/react';

import { toast } from 'sonner';

import { aiChatPlugin } from '@/components/editor/plugins/ai-kit';
import { apiUrls } from '@/client/api-client';
import { resolveAgentPyTarget } from '@/client/api/backend-resolver';
import { getChatModel } from '@/shared/models';

import { agentPyCommand, agentPyInit } from './ai/agent-py-body';
import { notifyAuthRequired } from '@/client/auth/auth-required';
import { isAuthRequiredError } from '@/shared/api-errors';

import { discussionPlugin } from './plugins/discussion-kit';
import { withAIBatch } from '@platejs/ai';

export type ToolName = 'comment' | 'edit' | 'generate';

export type TComment = {
  comment: {
    blockId: string;
    comment: string;
    content: string;
  } | null;
  status: 'finished' | 'streaming';
};

export type TTableCellUpdate = {
  cellUpdate: {
    content: string;
    id: string;
  } | null;
  status: 'finished' | 'streaming';
};

export type MessageDataPart = {
  toolName: ToolName;
  comment?: TComment;
  table?: TTableCellUpdate;
};

export type Chat = UseChatHelpers<ChatMessage>;

const notedSwitches = new Set<string>();

/** Q102: the settings' model isn't one agent-py runs — say so, once per
 *  model and session, rather than failing every request. */
function noteModelSwitch(from: string, to: string | null | undefined) {
  if (notedSwitches.has(from)) return;
  notedSwitches.add(from);
  const label = (id: string) => getChatModel(id)?.label ?? id;
  toast.info(
    `${label(from)} isn't available for editor AI on agent-py. Using ${to ? label(to) : 'its default model'}.`
  );
}

export type ChatMessage = UIMessage<{}, MessageDataPart>;

export const useChat = () => {
  const editor = useEditorRef();
  const options = usePluginOption(aiChatPlugin, 'chatOptions');

  const baseChat = useBaseChat<ChatMessage>({
    id: 'editor',
    transport: new DefaultChatTransport({
      api: options.api || apiUrls.aiCommand(),
      // agent-py's `/v1/ai/command` (Q105), with the session's bearer or
      // tokenless; the browser renders the document into its body
      // (`agentPyCommand`). There is no own-key setting (Q124) and no mock.
      fetch: (async (_input, init) => {
        const bodyOptions = editor.getOptions(aiChatPlugin).chatOptions?.body;

        const initBody = JSON.parse(init?.body as string);

        const body = {
          ...initBody,
          ...bodyOptions,
        };

        const target = await resolveAgentPyTarget();
        const command = agentPyCommand(body);
        if (command.switchedFrom) noteModelSwitch(command.switchedFrom, command.body.model);
        const res = await fetch(
          `${target.baseUrl}/v1/ai/command`,
          agentPyInit(init, target.authToken, command.body)
        );

        if (!res.ok) {
          // Peek at the categorised error shape ({ code, message }) and
          // say what failed; the AI SDK still sees the error.
          let errorBody: { code?: string; message?: string } | null = null;
          try {
            errorBody = (await res.clone().json()) as {
              code?: string;
              message?: string;
            };
          } catch {
            /* non-JSON body */
          }

          // REQUIRE_AUTH_FOR_AI (or a tokenless call refused): the caller
          // must sign in — toast with a "Sign in" action.
          if (
            isAuthRequiredError(errorBody) ||
            (res.status === 401 && target.authToken === null)
          ) {
            notifyAuthRequired();
            return res;
          }

          const label =
            errorBody?.code === 'rate_limit'
              ? 'Rate limited'
              : errorBody?.code === 'invalid_model'
                ? 'Model unavailable'
                : errorBody?.code === 'unknown_model'
                  ? "This model isn't available on this server — pick another model"
                  : errorBody?.code === 'provider'
                    ? 'Provider error'
                    : 'Editor AI failed';
          toast.error(
            errorBody?.message ? `${label}: ${errorBody.message}` : label
          );
        }

        return res;
      }) as typeof fetch,
    }),
    onData(data) {
      if (data.type === 'data-toolName') {
        editor.setOption(AIChatPlugin, 'toolName', data.data as ToolName);
      }

      if (data.type === 'data-table' && data.data) {
        const tableData = data.data as TTableCellUpdate;

        if (tableData.status === 'finished') {
          const chatSelection = editor.getOption(AIChatPlugin, 'chatSelection');

          if (!chatSelection) return;

          editor.tf.setSelection(chatSelection);

          return;
        }

        const cellUpdate = tableData.cellUpdate!;

        withAIBatch(editor, () => {
          applyTableCellSuggestion(editor, cellUpdate);
        });
      }

      if (data.type === 'data-comment' && data.data) {
        const commentData = data.data as TComment;

        if (commentData.status === 'finished') {
          editor.getApi(BlockSelectionPlugin).blockSelection.deselect();

          return;
        }

        const aiComment = commentData.comment!;
        const range = aiCommentToRange(editor, aiComment);

        if (!range) return console.warn('No range found for AI comment');

        const discussions =
          editor.getOption(discussionPlugin, 'discussions') || [];

        // Generate a new discussion ID
        const discussionId = nanoid();

        // Create a new comment
        const newComment = {
          id: nanoid(),
          contentRich: [{ children: [{ text: aiComment.comment }], type: 'p' }],
          createdAt: new Date(),
          discussionId,
          isEdited: false,
          userId: editor.getOption(discussionPlugin, 'currentUserId'),
        };

        // Create a new discussion
        const newDiscussion = {
          id: discussionId,
          comments: [newComment],
          createdAt: new Date(),
          documentContent: deserializeMd(editor, aiComment.content)
            .map((node: TNode) => NodeApi.string(node))
            .join('\n'),
          isResolved: false,
          userId: editor.getOption(discussionPlugin, 'currentUserId'),
        };

        // Update discussions
        const updatedDiscussions = [...discussions, newDiscussion];
        editor.setOption(discussionPlugin, 'discussions', updatedDiscussions);

        // Apply comment marks to the editor
        editor.tf.withMerging(() => {
          editor.tf.setNodes(
            {
              [getCommentKey(newDiscussion.id)]: true,
              [getTransientCommentKey()]: true,
              [KEYS.comment]: true,
            },
            {
              at: range,
              match: TextApi.isText,
              split: true,
            }
          );
        });
      }
    },

    ...options,
  });

  const chat = baseChat;

  React.useEffect(() => {
    editor.setOption(AIChatPlugin, 'chat', chat as any);

  }, [chat.status, chat.messages, chat.error]);

  return chat;
};
