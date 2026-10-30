import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_basic,
  tableFeatures,
  useTable,
  type RowData,
  type SortingState,
} from '@tanstack/react-table';
import { useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from './States';

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { basic: sortFn_basic },
});

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** value used for sorting; columns without it are not sortable */
  sortValue?: (row: T) => number | string;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  /** muted text colour */
  muted?: boolean;
}

/**
 * TanStack Table (row model + sorting) rendered with MUI's table: sticky header, compact rows,
 * click a sortable header to sort.
 */
export function DataTable<T extends RowData>({
  columns,
  data,
  getRowId,
  caption,
  empty = 'No rows',
  maxHeight,
  initialSort,
  rowSx,
}: {
  columns: readonly Column<T>[];
  data: readonly T[];
  getRowId: (row: T, index: number) => string;
  caption?: string;
  empty?: ReactNode;
  maxHeight?: number | string;
  initialSort?: SortingState;
  rowSx?: (row: T) => object | undefined;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSort ?? []);
  const defs = useMemo(() => {
    const helper = createColumnHelper<typeof features, T>();
    return helper.columns(
      columns.map((c) =>
        helper.accessor((row: T) => (c.sortValue ? c.sortValue(row) : ''), {
          id: c.id,
          header: () => c.header,
          cell: (ctx) => c.cell(ctx.row.original),
          enableSorting: !!c.sortValue,
          sortFn: 'basic',
        }),
      ),
    );
  }, [columns]);
  const byId = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const table = useTable({
    features,
    columns: defs,
    // useTable wants a mutable array; it never writes to it
    data: data,
    getRowId,
    state: { sorting },
    onSortingChange: setSorting,
  });

  if (!data.length) return <EmptyState>{empty}</EmptyState>;

  return (
    <TableContainer sx={{ maxHeight, height: maxHeight ? undefined : '100%' }}>
      <Table stickyHeader size="small" aria-label={caption}>
        <TableHead>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => {
                const col = byId.get(header.column.id);
                const sorted = header.column.getIsSorted();
                return (
                  <TableCell
                    key={header.id}
                    align={col?.align}
                    sx={{ width: col?.width }}
                    sortDirection={sorted === false ? false : sorted}
                  >
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <TableSortLabel
                        active={sorted !== false}
                        direction={sorted === false ? 'asc' : sorted}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <table.FlexRender header={header} />
                      </TableSortLabel>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableHead>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} hover sx={rowSx?.(row.original)}>
              {row.getAllCells().map((cell) => {
                const col = byId.get(cell.column.id);
                return (
                  <TableCell
                    key={cell.id}
                    align={col?.align}
                    sx={col?.muted ? { color: 'text.secondary' } : undefined}
                  >
                    <table.FlexRender cell={cell} />
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Box sx={{ height: 2 }} />
    </TableContainer>
  );
}
