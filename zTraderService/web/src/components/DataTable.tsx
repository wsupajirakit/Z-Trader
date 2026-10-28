import {
  createColumnHelper,
  tableFeatures,
  useTable,
  type RowData,
} from '@tanstack/react-table';
import { useMemo, type ReactNode } from 'react';

/** Core row model only: the dashboard tables neither sort nor filter client-side. */
const features = tableFeatures({});

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** class of the <td> (e.g. "muted") */
  className?: string;
}

/**
 * Thin TanStack Table wrapper: callers describe columns as `row => ReactNode`, the table owns
 * the row/header model, and the markup stays the plain `<table>` the ported CSS styles.
 */
export function DataTable<T extends RowData>({
  columns,
  data,
  getRowId,
  caption,
}: {
  columns: readonly Column<T>[];
  data: readonly T[];
  getRowId: (row: T, index: number) => string;
  caption?: string;
}) {
  const defs = useMemo(() => {
    const helper = createColumnHelper<typeof features, T>();
    return helper.columns(
      columns.map((c) =>
        helper.display({
          id: c.id,
          header: () => c.header,
          cell: (ctx) => c.cell(ctx.row.original),
        }),
      ),
    );
  }, [columns]);
  const classById = useMemo(
    () => new Map(columns.map((c) => [c.id, c.className])),
    [columns],
  );
  // useTable wants a mutable array; it never writes to it.
  const rows = data as T[];

  const table = useTable({ features, columns: defs, data: rows, getRowId });

  return (
    <table>
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((header) => (
              <th key={header.id} scope="col">
                {header.isPlaceholder ? null : (
                  <table.FlexRender header={header} />
                )}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id}>
            {row.getAllCells().map((cell) => (
              <td key={cell.id} className={classById.get(cell.column.id)}>
                <table.FlexRender cell={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
