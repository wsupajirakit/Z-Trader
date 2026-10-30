import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { ArchiveEntry, GoldMode } from '../../api/types';
import { DataTable, type Column } from '../../components/DataTable';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { RouterMuiLink } from '../../components/RouterMuiLink';
import { Panel } from '../../components/Panel';
import { ErrorState, LoadingState } from '../../components/States';
import { archiveListQuery } from '../../data/queries';
import { dateTime, fmtBytes } from '../../lib/format';
import { outcomeTone } from '../bot/decision';
import {
  ARCHIVE_LIMITS,
  ARCHIVE_MODES,
  archiveParams,
  DEFAULT_ARCHIVE_LIMIT,
} from './archiveSearch';

const route = getRouteApi('/app/archive');
const TONE = {
  ok: 'terminal.up',
  err: 'terminal.down',
  wait: 'warning.main',
  no: 'text.secondary',
} as const;

/** every archived analysis round, filtered by mode */
export function ArchiveListPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const limit = search.limit ?? DEFAULT_ARCHIVE_LIMIT;
  const q = useQuery(archiveListQuery({ mode: search.mode, limit }));
  const columns = useMemo<Column<ArchiveEntry>[]>(
    () => [
      {
        id: 'file',
        header: 'Round',
        cell: (e) => {
          const p = archiveParams(e.file);
          return (
            <RouterMuiLink
              to="/archive/$mode/$file"
              params={p}
              underline="hover"
              className="num"
            >
              {p.file}
            </RouterMuiLink>
          );
        },
        sortValue: (e) => e.file,
      },
      {
        id: 'mode',
        header: 'Mode',
        cell: (e) => e.mode,
        sortValue: (e) => e.mode,
      },
      {
        id: 'outcome',
        header: 'Outcome',
        cell: (e) => (
          <Box component="span" sx={{ color: TONE[outcomeTone(e.outcome)] }}>
            {e.outcome}
          </Box>
        ),
        sortValue: (e) => e.outcome,
      },
      {
        id: 'time',
        header: 'Time',
        muted: true,
        cell: (e) => dateTime(e.mtime),
        sortValue: (e) => e.mtime,
      },
      {
        id: 'size',
        header: 'Size',
        align: 'right',
        muted: true,
        cell: (e) => fmtBytes(e.size),
        sortValue: (e) => e.size,
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Archive"
        subtitle="Every analysis round with its inputs and decision"
        actions={
          <>
            <TextField
              select
              size="small"
              label="Mode"
              value={search.mode ?? ''}
              onChange={(e) => {
                const mode = e.target.value as GoldMode | '';
                void navigate({
                  to: '/archive',
                  search: {
                    ...(mode ? { mode } : {}),
                    ...(search.limit ? { limit: search.limit } : {}),
                  },
                });
              }}
              sx={{ minWidth: 130 }}
            >
              <MenuItem value="">All modes</MenuItem>
              {ARCHIVE_MODES.map((m) => (
                <MenuItem key={m} value={m}>
                  {m}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label="Rows"
              value={limit}
              onChange={(e) => {
                void navigate({
                  to: '/archive',
                  search: {
                    ...(search.mode ? { mode: search.mode } : {}),
                    limit: Number(e.target.value),
                  },
                });
              }}
              sx={{ minWidth: 90 }}
            >
              {ARCHIVE_LIMITS.map((l) => (
                <MenuItem key={l} value={l}>
                  {l}
                </MenuItem>
              ))}
            </TextField>
          </>
        }
      />
      <PageBody>
        <Panel title="Rounds" dense>
          {q.isPending ? (
            <LoadingState />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          ) : (
            <DataTable
              columns={columns}
              data={q.data}
              getRowId={(e) => e.file}
              caption="Archive"
              empty="No archived rounds"
            />
          )}
        </Panel>
      </PageBody>
    </>
  );
}
