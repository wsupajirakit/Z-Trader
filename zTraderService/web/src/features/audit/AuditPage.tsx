import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { auditApi } from '../../api/audit';
import { describeError } from '../../api/client';
import { qk } from '../../api/queryKeys';
import type { AuditEvent } from '../../api/types';
import { DataTable, type Column } from '../../components/DataTable';
import { dateTimeTh } from '../../lib/time';

const PAGE_SIZE = 50;

/** Admin: audit log, newest first, paged with the `before` cursor. */
export function AuditPage() {
  const audit = useInfiniteQuery({
    queryKey: qk.audit.list(PAGE_SIZE),
    queryFn: ({ pageParam, signal }) =>
      auditApi.page({ limit: PAGE_SIZE, before: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
  });
  const rows = useMemo(
    () => audit.data?.pages.flatMap((p) => p.items) ?? [],
    [audit.data],
  );

  return (
    <main className="page">
      <div className="card">
        <h2>Audit log</h2>
        <div className="toolbar">
          <button
            type="button"
            className="btn-sm"
            disabled={audit.isFetching}
            onClick={() => {
              void audit.refetch();
            }}
          >
            🔄 โหลดใหม่
          </button>
          {audit.isFetching ? <span className="muted">กำลังโหลด…</span> : null}
        </div>
        {audit.isPending ? (
          <div className="muted">กำลังโหลด…</div>
        ) : audit.error && !rows.length ? (
          <div className="muted">โหลดไม่ได้: {describeError(audit.error)}</div>
        ) : !rows.length ? (
          <div className="muted">ยังไม่มีเหตุการณ์</div>
        ) : (
          <DataTable columns={COLUMNS} data={rows} getRowId={(e) => e.id} />
        )}
        {audit.hasNextPage ? (
          <div className="row">
            <button
              type="button"
              className="btn-inline"
              disabled={audit.isFetchingNextPage}
              onClick={() => {
                void audit.fetchNextPage();
              }}
            >
              โหลดเพิ่ม
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function detailText(d: AuditEvent['detail']): string {
  if (!d) return '';
  const s = JSON.stringify(d);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

const COLUMNS: Column<AuditEvent>[] = [
  {
    id: 'at',
    header: 'เวลา',
    cell: (e) => dateTimeTh(e.at),
    className: 'muted',
  },
  { id: 'actor', header: 'ผู้ทำ', cell: (e) => e.actor?.username ?? '—' },
  { id: 'action', header: 'การกระทำ', cell: (e) => <code>{e.action}</code> },
  { id: 'target', header: 'เป้าหมาย', cell: (e) => e.target ?? '—' },
  {
    id: 'success',
    header: 'ผล',
    cell: (e) =>
      e.success ? (
        <span className="tag ok">สำเร็จ</span>
      ) : (
        <span className="tag bad">ล้มเหลว</span>
      ),
  },
  { id: 'ip', header: 'IP', cell: (e) => e.ip, className: 'muted' },
  {
    id: 'detail',
    header: 'รายละเอียด',
    cell: (e) => <span className="detail">{detailText(e.detail)}</span>,
  },
];
