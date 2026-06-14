'use client';

import type { PlateElementProps } from 'platejs/react';

import { PlateElement } from 'platejs/react';

import { CitationTableView } from '@/components/panels/citation-table';
import { useStore } from '@/client/hooks/use-store';
import { parseCitationTable } from '@/shared/artifacts/citation-table';
import type { MyCitationTableElement } from '@/components/editor/plate-types';

export function CitationTableElement(
  props: PlateElementProps<MyCitationTableElement>,
) {
  const { element } = props;
  const artifact = useStore((s) =>
    s.artifacts.find((a) => a.id === element.artifactId),
  );
  const table = artifact ? parseCitationTable(artifact.content) : null;

  return (
    <PlateElement
      {...props}
      attributes={{
        ...props.attributes,
        contentEditable: false,
      }}
    >
      <div className="my-2 overflow-hidden rounded-md border border-[var(--border)]">
        {table ? (
          <CitationTableView data={table} />
        ) : (
          <div className="p-3 text-xs text-[var(--muted-foreground)]">
            Citation table unavailable
          </div>
        )}
      </div>
      {props.children}
    </PlateElement>
  );
}
