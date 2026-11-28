'use client';

import type { PlateElementProps } from 'platejs/react';

import { PlateElement, useReadOnly } from 'platejs/react';

import { CitationTableView } from '@/components/panels/citation-table';
import { useStore } from '@/client/hooks/use-store';
import { parseCitationTable } from '@/shared/artifacts/citation-table';
import type { MyCitationTableElement } from '@/components/editor/plate-types';

export function CitationTableElement(
  props: PlateElementProps<MyCitationTableElement>,
) {
  const { element } = props;
  const readOnly = useReadOnly();
  const artifact = useStore((s) =>
    s.artifacts.find((a) => a.id === element.artifactId),
  );
  const updateArtifactContent = useStore((s) => s.updateArtifactContent);
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
          <div
            // Keep cell-input clicks/keys from reaching Slate's editor-level
            // handlers (selection, hotkeys, void-node deletion) while editing.
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <CitationTableView
              data={table}
              onChange={
                readOnly || !artifact
                  ? undefined
                  : (next) =>
                      updateArtifactContent(artifact.id, JSON.stringify(next))
              }
            />
          </div>
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
