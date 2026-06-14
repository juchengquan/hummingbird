'use client';

import { createPlatePlugin } from 'platejs/react';

import { CitationTableElement } from '@/components/ui/citation-table-node';
import { CITATION_TABLE_KEY } from '@/shared/artifacts/citation-table-md';

export const CitationTablePlugin = createPlatePlugin({
  key: CITATION_TABLE_KEY,
  node: {
    isElement: true,
    isVoid: true,
  },
}).withComponent(CitationTableElement);

export const CitationTableKit = [CitationTablePlugin];
