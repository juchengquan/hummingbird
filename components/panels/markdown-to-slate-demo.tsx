'use client';

import * as React from 'react';

import { MarkdownPlugin, remarkMdx, remarkMention } from '@platejs/markdown';
import { Plate, usePlateEditor } from 'platejs/react';
import type { TNode } from 'platejs';
import type { Plugin } from 'unified';
import remarkEmoji from 'remark-emoji';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import { EditorKit } from "@/components/third-party/plate/editor/editor-kit"
import { useDebounce } from '@/hooks/use-debounce';
import { useStore } from '@/lib/hooks/use-store';
import { Editor, EditorContainer } from "@/components/third-party/plate/ui/editor"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"

export default function MarkdownDemo() {
  // Get editor content from store (set by chat)
  const editorContent = useStore((state) => state.editorContent)

  const [markdownValue, setMarkdownValue] = React.useState(editorContent || "");
  const debouncedValue = useDebounce(markdownValue, 600);
  const isUpdatingFromRichText = React.useRef(false);

  // Sync with store when editorContent changes from chat
  React.useEffect(() => {
    if (editorContent && editorContent !== markdownValue) {
      setMarkdownValue(editorContent)
    }
  }, [editorContent])

  // Left panel: plain text editor (shows markdown source)
  const plainTextEditor = usePlateEditor({
    plugins: [],
    value: [{ children: [{ text: markdownValue }], type: 'p' }],
  });

  // Right panel: rich text editor (shows formatted content)
  const richTextEditor = usePlateEditor(
    {
      plugins: EditorKit,
      value: (editor) =>
        editor.getApi(MarkdownPlugin).markdown.deserialize(markdownValue || "", {
          remarkPlugins: [
            remarkMath,
            remarkGfm,
            remarkMdx,
            remarkMention,
            remarkEmoji as unknown as Plugin,
          ],
        }),
    },
    []
  );

  // Sync: right panel → left panel
  // When markdownValue changes (from right), update plain text editor
  React.useEffect(() => {
    if (plainTextEditor && plainTextEditor.children && plainTextEditor.children.length > 0) {
      const currentContent = plainTextEditor.children
        .map((node: TNode) => plainTextEditor.api.string(node))
        .join('\n')
      if (currentContent !== markdownValue) {
        isUpdatingFromRichText.current = true
        plainTextEditor.tf.setValue([{ children: [{ text: markdownValue }], type: 'p' }])
        setTimeout(() => {
          isUpdatingFromRichText.current = false
        }, 0)
      }
    }
  }, [markdownValue, plainTextEditor]);

  // Sync: left panel → right panel
  // When debounced value changes (from left), update rich text editor
  React.useEffect(() => {
    if (richTextEditor?.api?.markdown && debouncedValue) {
      const currentMarkdown = richTextEditor.api.markdown.serialize()
      if (currentMarkdown !== debouncedValue) {
        richTextEditor.tf.setValue(
          richTextEditor.api.markdown.deserialize(debouncedValue, {
            remarkPlugins: [
              remarkMath,
              remarkGfm,
              remarkMdx,
              remarkMention,
              remarkEmoji as unknown as Plugin,
            ],
          })
        )
      }
    }
  }, [debouncedValue, richTextEditor]);

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-full"
    >
      <ResizablePanel defaultSize={50} minSize={20}>
        <Plate
          onValueChange={() => {
            // Skip update when syncing from right panel to avoid infinite loop
            if (isUpdatingFromRichText.current) return
            const value = plainTextEditor.children
              .map((node: TNode) => plainTextEditor.api.string(node))
              .join('\n');
            setMarkdownValue(value);
          }}
          editor={plainTextEditor}
        >
          <EditorContainer className="h-full">
            <Editor
              variant="none"
              className="bg-muted/50 p-2 font-mono text-sm h-full"
            />
          </EditorContainer>
        </Plate>
      </ResizablePanel>

      <ResizableHandle withHandle className="w-1" style={{ transform: "translateX(-50%)" }} />

      <ResizablePanel defaultSize={50} minSize={20}>
        <Plate
          editor={richTextEditor}
          onValueChange={() => {
            const markdown = richTextEditor.api.markdown.serialize();
            if (markdown !== markdownValue) {
              setMarkdownValue(markdown);
            }
          }}
        >
          <EditorContainer className="h-full">
            <Editor variant="none" className="px-6 py-2 h-full" />
          </EditorContainer>
        </Plate>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
