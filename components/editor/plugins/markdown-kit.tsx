import { MarkdownPlugin, remarkMdx, remarkMention } from '@platejs/markdown';
import { KEYS } from 'platejs';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import {
  CITATION_TABLE_KEY,
  citationTableNodeToMdast,
  mdastMdxToCitationTableNode,
} from '@/shared/artifacts/citation-table-md';

export const MarkdownKit = [
  MarkdownPlugin.configure({
    options: {
      plainMarks: [KEYS.suggestion, KEYS.comment],
      remarkPlugins: [remarkMath, remarkGfm, remarkMdx, remarkMention],
      rules: {
        [CITATION_TABLE_KEY]: {
          serialize: (slateNode: { artifactId?: string }) =>
            citationTableNodeToMdast({ artifactId: slateNode.artifactId ?? '' }),
          deserialize: (mdastNode: {
            name?: string;
            attributes?: { name?: string; value?: string }[];
          }) =>
            mdastMdxToCitationTableNode(mdastNode) ?? {
              type: CITATION_TABLE_KEY,
              artifactId: '',
              children: [{ text: '' }],
            },
        },
      },
    },
  }),
];
