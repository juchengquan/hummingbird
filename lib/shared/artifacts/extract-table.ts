import type { ColumnType } from "./column-type"

/** A user-supplied column hint for "Extract table" (the popover's
 *  `columnHints`, sent to agent-py's `/v1/extract-table`): the label to
 *  use verbatim and, optionally, the type its values should take. */
export type ExtractColumnHint = { label: string; type?: ColumnType }
