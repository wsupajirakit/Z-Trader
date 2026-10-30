import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { auditApi } from '../../api/audit';
import { qk } from '../../api/queryKeys';
import type { AuditEvent } from '../../api/types';
import { DataTable, type Column } from '../../components/DataTable';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { Panel } from '../../components/Panel';
import { ErrorState, LoadingState } from '../../components/States';
import { dateTime } from '../../lib/format';
import { FONT_MONO } from '../../theme/tokens';

const PAGE_SIZE = 50;

/** admin: audit trail of every sign-in and action, newest first, paged */
export function AuditPage() {
  const [filter, setFilter] = useState('');
  const audit = useInfiniteQuery({
    queryKey: qk.audit.list(PAGE_SIZE),
    queryFn: ({ pageParam, signal }) =>
      auditApi.page({ limit: PAGE_SIZE, before: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
  });
  const rows = useMemo(() => {
    const all = audit.data?.pages.flatMap((p) => p.items) ?? [];
    const f = filter.trim().toLowerCase();
    return f
      ? all.filter((e) =>
          `${e.action} ${e.actor?.username ?? ''} ${e.target ?? ''} ${e.ip}`
            .toLowerCase()
            .includes(f),
        )
      : all;
  }, [audit.data, filter]);
  const columns = useMemo<Column<AuditEvent>[]>(
    () => [
      {
        id: 'at',
        header: 'Time',
        cell: (e) => <span className="num">{dateTime(e.at)}</span>,
        sortValue: (e) => e.at,
      },
      {
        id: 'actor',
        header: 'User',
        cell: (e) => e.actor?.username ?? '—',
        sortValue: (e) => e.actor?.username ?? '',
      },
      {
        id: 'action',
        header: 'Action',
        cell: (e) => <span className="num">{e.action}</span>,
        sortValue: (e) => e.action,
      },
      {
        id: 'target',
        header: 'Target',
        muted: true,
        cell: (e) => e.target ?? '',
      },
      {
        id: 'ok',
        header: 'Result',
        cell: (e) =>
          e.success ? (
            <Chip color="success" variant="outlined" label="ok" />
          ) : (
            <Chip color="error" variant="outlined" label="failed" />
          ),
      },
      {
        id: 'ip',
        header: 'IP',
        muted: true,
        cell: (e) => <span className="num">{e.ip}</span>,
      },
      {
        id: 'detail',
        header: 'Detail',
        cell: (e) =>
          e.detail ? (
            <Tooltip
              title={
                <Box
                  component="pre"
                  sx={{ m: 0, fontSize: 10.5, whiteSpace: 'pre-wrap' }}
                >
                  {JSON.stringify(e.detail, null, 2)}
                </Box>
              }
            >
              <Box
                sx={{
                  maxWidth: 320,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'text.secondary',
                  fontFamily: FONT_MONO,
                  fontSize: 10.5,
                }}
              >
                {JSON.stringify(e.detail)}
              </Box>
            </Tooltip>
          ) : (
            ''
          ),
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Audit log"
        actions={
          <>
            <TextField
              size="small"
              placeholder="Filter loaded rows…"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
              }}
              slotProps={{ htmlInput: { 'aria-label': 'Filter audit rows' } }}
            />
            <Button
              onClick={() => void audit.refetch()}
              disabled={audit.isFetching}
            >
              Reload
            </Button>
          </>
        }
      />
      <PageBody>
        <Panel title={`Events (${rows.length})`} dense>
          {audit.isPending ? (
            <LoadingState />
          ) : audit.isError ? (
            <ErrorState
              error={audit.error}
              onRetry={() => void audit.refetch()}
            />
          ) : (
            <DataTable
              columns={columns}
              data={rows}
              getRowId={(e) => e.id}
              caption="Audit events"
            />
          )}
          {audit.hasNextPage ? (
            <Box sx={{ p: 2, textAlign: 'center' }}>
              <Button
                variant="outlined"
                disabled={audit.isFetchingNextPage}
                onClick={() => void audit.fetchNextPage()}
              >
                Load more
              </Button>
            </Box>
          ) : null}
        </Panel>
      </PageBody>
    </>
  );
}
