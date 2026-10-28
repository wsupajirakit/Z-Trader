import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { describeError } from '../../../api/client';
import type { ArchiveEntry } from '../../../api/types';
import { DataTable, type Column } from '../../../components/DataTable';
import { fmtBytes } from '../../../lib/format';
import { dateTimeTh } from '../../../lib/time';
import { archiveListQuery } from '../queries';
import { outcomeIcon } from '../stats/modeCard';
import {
  ARCHIVE_LIMITS,
  ARCHIVE_MODES,
  archiveParams,
  DEFAULT_ARCHIVE_LIMIT,
} from './archiveSearch';

const route = getRouteApi('/app/archive');

/** Every archived round (one JSON per analysis), filterable by mode. */
export function ArchiveListPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const limit = search.limit ?? DEFAULT_ARCHIVE_LIMIT;
  const { data, error, isPending, isFetching } = useQuery(
    archiveListQuery({ mode: search.mode, limit }),
  );

  return (
    <main className="page">
      <div className="card">
        <h2>Archive — ประวัติการวิเคราะห์ทุกรอบ</h2>
        <div className="toolbar">
          <label htmlFor="arch-mode">โหมด</label>
          <select
            id="arch-mode"
            value={search.mode ?? ''}
            onChange={(e) => {
              const mode = ARCHIVE_MODES.find((m) => m === e.target.value);
              void navigate({ search: (prev) => ({ ...prev, mode }) });
            }}
          >
            <option value="">ทุกโหมด</option>
            {ARCHIVE_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <label htmlFor="arch-limit">จำนวน</label>
          <select
            id="arch-limit"
            value={limit}
            onChange={(e) => {
              void navigate({
                search: (prev) => ({ ...prev, limit: Number(e.target.value) }),
              });
            }}
          >
            {ARCHIVE_LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          {isFetching ? <span className="muted">กำลังโหลด…</span> : null}
        </div>
        {isPending ? (
          <div className="muted">กำลังโหลด…</div>
        ) : error ? (
          <div className="muted">โหลดไม่ได้: {describeError(error)}</div>
        ) : !data.length ? (
          <div className="muted">ยังไม่มีประวัติ</div>
        ) : (
          <DataTable columns={COLUMNS} data={data} getRowId={(a) => a.file} />
        )}
      </div>
    </main>
  );
}

const COLUMNS: Column<ArchiveEntry>[] = [
  {
    id: 'file',
    header: 'ไฟล์',
    cell: (a) => (
      <Link to="/archive/$mode/$file" params={archiveParams(a.file)}>
        {outcomeIcon(a.outcome)}{' '}
        {archiveParams(a.file).file.replace('.json', '')}
      </Link>
    ),
  },
  { id: 'mode', header: 'โหมด', cell: (a) => a.mode },
  { id: 'outcome', header: 'ผล', cell: (a) => a.outcome },
  {
    id: 'mtime',
    header: 'เวลา',
    cell: (a) => dateTimeTh(a.mtime),
    className: 'muted',
  },
  {
    id: 'size',
    header: 'ขนาด',
    cell: (a) => fmtBytes(a.size),
    className: 'muted',
  },
];
