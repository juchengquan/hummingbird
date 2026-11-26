/**
 * Pure helpers of the editor AI prompts (`./prompt/`): structured prompt
 * sections and the message history. No Plate: the document arrives as
 * text (`EditorAiDocument`, built from the editor by
 * `components/editor/ai/editor-ai-document.ts`) — in the browser for
 * agent-py, in the Next route for itself (Q101). agent-py's port:
 * `services/agent-py/src/agent_py/editor_ai/prompts.py`, pinned by
 * `prompt/prompts.parity.test.ts`.
 */

import dedent from 'dedent';

/** The parts of an AI SDK `UIMessage` the prompts read. */
export type EditorAiMessage = {
  role: string;
  parts: { type: string; text?: string }[];
};

/** The document as the prompts need it (Q101). `null` where the
 *  selection doesn't call for it. */
export type EditorAiDocument = {
  /** The selection is expanded (a range, not a caret). */
  isSelecting: boolean;
  /** `generate`'s `<context>` when selecting: the selected blocks'
   *  markdown, `<Selection>` marked inside one block. */
  generateContext: string | null;
  /** `edit`, when selecting: which edit prompt and its `<context>`. */
  edit: { kind: EditKind; context: string } | null;
  /** `comment`'s `<context>`: the blocks with their ids. */
  commentContext: string;
};

export type EditKind = 'multi-block' | 'selection' | 'table';

/**
 * Tag content split by newlines
 *
 * @example
 *   <tools>
 *   {content}
 *   </tools>
 */
export const tag = (tag: string, content?: string | null) => {
  if (!content) return '';

  return [`<${tag}>`, content, `</${tag}>`].join('\n');
};

/**
 * Tag content inline
 *
 * @example
 *   <tools>{content}</tools>
 */
export const inlineTag = (tag: string, content?: string | null) => {
  if (!content) return '';

  return [`<${tag}>`, content, `</${tag}>`].join('');
};

// Sections split by double newlines
export const sections = (sections: (boolean | string | null | undefined)[]) =>
  sections.filter(Boolean).join('\n\n');

// List items split by newlines
export const list = (items: string[] | undefined) =>
  items
    ? items
        .filter(Boolean)
        .map((item) => `- ${item}`)
        .join('\n')
    : '';

export type StructuredPromptSections = {
  context?: string;
  examples?: string[] | string;
  history?: string;
  instruction?: string;
  outputFormatting?: string;
  prefilledResponse?: string;
  rules?: string;
  task?: string;
  taskContext?: string;
  thinking?: string;
  tone?: string;
};

/**
 * Build a structured prompt following best practices for AI interactions.
 *
 * @example
 *   https://imgur.com/carbon-Db5tDUh
 *   1. Task context - You will be acting as an AI career coach named Joe created by the company
 *   AdAstra Careers. Your goal is to give career advice to users. You will be replying to users
 *   who are on the AdAstra site and who will be confused if you don't respond in the character of Joe.
 *   2. Tone context - You should maintain a friendly customer service tone.
 *   3. Background data - Here is the career guidance document you should reference when answering the user: <guide>{DOCUMENT}</guide>
 *   3b. Tools - Available tool descriptions
 *   4. Rules - Here are some important rules for the interaction:
 *   - Always stay in character, as Joe, an AI from AdAstra careers
 *   - If you are unsure how to respond, say "Sorry, I didn't understand that. Could you repeat the question?"
 *   - If someone asks something irrelevant, say, "Sorry, I am Joe and I give career advice..."
 *   5. Examples - Here is an example of how to respond in a standard interaction:
 *   <example>
 *   User: Hi, how were you created and what do you do?
 *   Joe: Hello! My name is Joe, and I was created by AdAstra Careers to give career advice...
 *   </example>
 *   6. Conversation history - Here is the conversation history (between the user and you) prior to the question. <history>{HISTORY}</history>
 *   6b. Question - Here is the user's question: <question>{QUESTION}</question>
 *   7. Immediate task - How do you respond to the user's question?
 *   8. Thinking - Think about your answer first before you respond.
 *   9. Output formatting - Put your response in <response></response> tags.
 *   11. Prefilled response - Optional response starter
 */
export const buildStructuredPrompt = ({
  context,
  examples,
  history,
  instruction,
  outputFormatting,
  prefilledResponse,
  rules,
  task,
  taskContext,
  thinking,
  tone,
}: StructuredPromptSections) => {
  const formattedExamples = Array.isArray(examples)
    ? examples
        .map((example) => {
          // Indent content inside example tag (4 spaces)
          const indentedContent = example
            .split('\n')
            .map((line) => (line ? `    ${line}` : ''))
            .join('\n');

          return ['  <example>', indentedContent, '  </example>'].join('\n');
        })
        .join('\n')
    : examples;

  return sections([
    taskContext,
    tone,

    task && tag('task', task),

    instruction &&
      dedent`
        Here is the user's instruction (this is what you need to respond to):
        ${tag('instruction', instruction)}
      `,

    context &&
      dedent`
        Here is the context you should reference when answering the user:
        ${tag('context', context)}
      `,

    rules && tag('rules', rules),

    formattedExamples &&
      'Here are some examples of how to respond in a standard interaction:\n' +
        tag('examples', formattedExamples),

    history &&
      dedent`
        Here is the conversation history (between the user and you) prior to the current instruction:
        ${tag('history', history)}
      `,

    // or <reasoningSteps>
    thinking && tag('thinking', thinking),
    // Not needed with structured output
    outputFormatting && tag('outputFormatting', outputFormatting),
    // Not needed with structured output
    (prefilledResponse ?? null) !== null &&
      tag('prefilledResponse', prefilledResponse ?? ''),
  ]);
};

export function getTextFromMessage(message: EditorAiMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

/**
 * Format conversation history for prompts. Extracts text from messages and
 * formats as ROLE: text. Returns empty string if only one message (no history needed).
 */
export function formatTextFromMessages(
  messages: EditorAiMessage[],
  options?: { limit?: number }
): string {
  // No history needed if no messages or only one message
  if (!messages || messages.length <= 1) return '';

  const historyMessages = options?.limit
    ? messages.slice(-options.limit)
    : messages;

  return historyMessages
    .map((message) => {
      const text = getTextFromMessage(message).trim();

      if (!text) return null;

      const role = message.role.toUpperCase();

      return `${role}: ${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Get the last user message text from messages array.
 */
export function getLastUserInstruction(messages: EditorAiMessage[]): string {
  if (!messages || messages.length === 0) return '';

  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m.role === 'user');

  if (!lastUserMessage) return '';

  return getTextFromMessage(lastUserMessage).trim();
}
