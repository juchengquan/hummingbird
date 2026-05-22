import type {
  ChatMessage,
  ToolName,
} from '@/components/editor/use-chat';
import type { NextRequest } from 'next/server';

import {
  type LanguageModel,
  type UIMessageStreamWriter,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  Output,
  streamText,
  tool,
} from 'ai';
import { NextResponse } from 'next/server';
import { type SlateEditor, createSlateEditor, nanoid } from 'platejs';
import { z } from 'zod';

import { BaseEditorKit } from '@/components/editor/editor-base-kit';
import { markdownJoinerTransform } from '@/shared/markdown-joiner-transform';
import { categorizeError } from '@/shared/api-errors';
import {
  ProviderUnavailableError,
  selectModel,
} from '@/server/model-provider';

import {
  buildEditTableMultiCellPrompt,
  getChooseToolPrompt,
  getCommentPrompt,
  getEditPrompt,
  getGeneratePrompt,
} from './prompt';

export async function POST(req: NextRequest) {
  const { apiKey: key, ctx, messages: messagesRaw, model } = await req.json();

  const { children, selection, toolName: toolNameParam } = ctx;

  const editor = createSlateEditor({
    plugins: BaseEditorKit,
    selection,
    value: children,
  });

  const isSelecting = editor.api.isExpanded();

  // Honour the per-request gateway key from the editor settings dialog.
  // `selectModel` falls back to the server-side gateway provider config
  // (env var) when this isn't set, and surfaces `ProviderUnavailableError`
  // — which we translate to 401 below — when neither is available.
  const pickModel = (id: string) =>
    selectModel(id, { gatewayApiKeyOverride: key });

  try {
    const stream = createUIMessageStream<ChatMessage>({
      execute: async ({ writer }) => {
        let toolName = toolNameParam;

        if (!toolName) {
          const prompt = getChooseToolPrompt({
            isSelecting,
            messages: messagesRaw,
          });

          const enumOptions = isSelecting
            ? ['generate', 'edit', 'comment']
            : ['generate', 'comment'];
          const modelId = model || 'google/gemini-2.5-flash';

          // @ts-expect-error AI SDK v5 typing for Output.choice doesn't
          // narrow `output` on the result; runtime is correct. See ROADMAP.
          const { output: AIToolName } = await generateText({
            model: pickModel(modelId),
            // @ts-expect-error see above
            output: Output.choice({ options: enumOptions }),
            prompt,
          });

          writer.write({
            data: AIToolName as ToolName,
            type: 'data-toolName',
          });

          toolName = AIToolName;
        }

        const stream = streamText({
          experimental_transform: markdownJoinerTransform(),
          model: pickModel(model || 'openai/gpt-5.5'),
          // Not used
          prompt: '',
          tools: {
            comment: getCommentTool(editor, {
              messagesRaw,
              model: pickModel(model || 'google/gemini-2.5-flash'),
              writer,
            }),
            table: getTableTool(editor, {
              messagesRaw,
              model: pickModel(model || 'google/gemini-2.5-flash'),
              writer,
            }),
          },
          prepareStep: async (step) => {
            if (toolName === 'comment') {
              return {
                ...step,
                toolChoice: { toolName: 'comment', type: 'tool' },
              };
            }

            if (toolName === 'edit') {
              const [editPrompt, editType] = getEditPrompt(editor, {
                isSelecting,
                messages: messagesRaw,
              });

              // Table editing uses the table tool
              if (editType === 'table') {
                return {
                  ...step,
                  toolChoice: { toolName: 'table', type: 'tool' },
                };
              }

              return {
                ...step,
                activeTools: [],
                model:
                  editType === 'selection'
                    ? //The selection task is more challenging, so we chose to use Gemini 2.5 Flash.
                      pickModel(model || 'google/gemini-2.5-flash')
                    : pickModel(model || 'openai/gpt-5.5'),
                messages: [
                  {
                    content: editPrompt,
                    role: 'user',
                  },
                ],
              };
            }

            if (toolName === 'generate') {
              const generatePrompt = getGeneratePrompt(editor, {
                isSelecting,
                messages: messagesRaw,
              });

              return {
                ...step,
                activeTools: [],
                messages: [
                  {
                    content: generatePrompt,
                    role: 'user',
                  },
                ],
                model: pickModel(model || 'openai/gpt-5.5'),
              };
            }
          },
        });

        writer.merge(stream.toUIMessageStream({ sendFinish: false }));
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    if (error instanceof ProviderUnavailableError) {
      return NextResponse.json(
        { code: 'auth', message: error.message },
        { status: 401 }
      );
    }
    const { status, code, message } = categorizeError(error);
    return NextResponse.json({ code, message }, { status });
  }
}

const getCommentTool = (
  editor: SlateEditor,
  {
    messagesRaw,
    model,
    writer,
  }: {
    messagesRaw: ChatMessage[];
    model: LanguageModel;
    writer: UIMessageStreamWriter<ChatMessage>;
  }
) =>
  tool({
    description: 'Comment on the content',
    // @ts-expect-error AI SDK v5 rejects empty Zod input schemas on tool()
    inputSchema: z.object({}),
    strict: true,
    // @ts-expect-error AI SDK v5 expects undefined execute when no inputSchema; runtime is correct
    execute: async () => {
      const commentSchema = z.object({
        blockId: z
          .string()
          .describe(
            'The id of the starting block. If the comment spans multiple blocks, use the id of the first block.'
          ),
        comment: z
          .string()
          .describe('A brief comment or explanation for this fragment.'),
        content: z
          .string()
          .describe(
            String.raw`The original document fragment to be commented on.It can be the entire block, a small part within a block, or span multiple blocks. If spanning multiple blocks, separate them with two \n\n.`
          ),
      });

      // @ts-expect-error AI SDK v5 typing for Output.array doesn't
      // expose `partialOutputStream`; runtime is correct.
      const { partialOutputStream } = streamText({
        model,
        // @ts-expect-error see above
        output: Output.array({ element: commentSchema }),
        prompt: getCommentPrompt(editor, {
          messages: messagesRaw,
        }),
      });

      let lastLength = 0;

      for await (const partialArray of partialOutputStream) {
        for (let i = lastLength; i < partialArray.length; i++) {
          const comment = partialArray[i];
          const commentDataId = nanoid();

          writer.write({
            id: commentDataId,
            data: {
              comment,
              status: 'streaming',
            },
            type: 'data-comment',
          });
        }

        lastLength = partialArray.length;
      }

      writer.write({
        id: nanoid(),
        data: {
          comment: null,
          status: 'finished',
        },
        type: 'data-comment',
      });
    },
  });

const getTableTool = (
  editor: SlateEditor,
  {
    messagesRaw,
    model,
    writer,
  }: {
    messagesRaw: ChatMessage[];
    model: LanguageModel;
    writer: UIMessageStreamWriter<ChatMessage>;
  }
) =>
  tool({
    description: 'Edit table cells',
    // @ts-expect-error see Comment-tool annotation above
    inputSchema: z.object({}),
    strict: true,
    // @ts-expect-error see Comment-tool annotation above
    execute: async () => {
      const cellUpdateSchema = z.object({
        content: z
          .string()
          .describe(
            String.raw`The new content for the cell. Can contain multiple paragraphs separated by \n\n.`
          ),
        id: z.string().describe('The id of the table cell to update.'),
      });

      // @ts-expect-error AI SDK v5 Output.array typing — see annotations above.
      const { partialOutputStream } = streamText({
        model,
        // @ts-expect-error see above
        output: Output.array({ element: cellUpdateSchema }),
        prompt: buildEditTableMultiCellPrompt(editor, messagesRaw),
      });

      let lastLength = 0;

      for await (const partialArray of partialOutputStream) {
        for (let i = lastLength; i < partialArray.length; i++) {
          const cellUpdate = partialArray[i];

          writer.write({
            id: nanoid(),
            data: {
              cellUpdate,
              status: 'streaming',
            },
            type: 'data-table',
          });
        }

        lastLength = partialArray.length;
      }

      writer.write({
        id: nanoid(),
        data: {
          cellUpdate: null,
          status: 'finished',
        },
        type: 'data-table',
      });
    },
  });
