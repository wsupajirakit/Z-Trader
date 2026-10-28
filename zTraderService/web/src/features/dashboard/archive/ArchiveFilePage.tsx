import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { describeError } from '../../../api/client';
import { archiveFileUrl } from '../../../api/dashboard';
import { archiveFileQuery } from '../queries';
import { ARCHIVE_MODES } from './archiveSearch';

const route = getRouteApi('/app/archive/$mode/$file');

/** One archived round as pretty JSON; "full" adds the bar series (large). */
export function ArchiveFilePage() {
  const { mode, file } = route.useParams();
  const { full = false } = route.useSearch();
  const { data, error, isPending } = useQuery(
    archiveFileQuery(mode, file, full),
  );

  return (
    <main className="page">
      <div className="card">
        <h2>
          Archive · {mode}/{file}
        </h2>
        <div className="toolbar">
          <Link
            to="/archive"
            search={{ mode: ARCHIVE_MODES.find((m) => m === mode) }}
          >
            ← รายการทั้งหมด
          </Link>
          <Link
            to="/archive/$mode/$file"
            params={{ mode, file }}
            search={full ? {} : { full: true }}
          >
            {full ? 'ซ่อนแท่งย้อนหลัง' : 'แสดงแท่งย้อนหลัง (full)'}
          </Link>
          <a
            href={archiveFileUrl(mode, file, full)}
            target="_blank"
            rel="noopener noreferrer"
          >
            เปิด JSON ดิบ
          </a>
        </div>
        {isPending ? (
          <div className="muted">กำลังโหลด…</div>
        ) : error ? (
          <div className="muted">
            อ่านไฟล์ประวัติไม่ได้: {describeError(error)}
          </div>
        ) : (
          <pre className="json-view">{JSON.stringify(data, null, 2)}</pre>
        )}
      </div>
    </main>
  );
}
