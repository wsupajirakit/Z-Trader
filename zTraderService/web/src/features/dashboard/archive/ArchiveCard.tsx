import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { truncate } from '../../../lib/format';
import { sidebarArchiveQuery } from '../queries';
import { outcomeIcon } from '../stats/modeCard';
import { archiveParams } from './archiveSearch';

/** Archive ล่าสุด — the 8 newest rounds; each opens the archive viewer in a new tab. */
export function ArchiveCard() {
  const { data } = useQuery(sidebarArchiveQuery);

  return (
    <div className="card arch">
      <h2>Archive ล่าสุด</h2>
      {!data ? (
        <div className="muted">—</div>
      ) : !data.length ? (
        <div className="muted">ยังไม่มีประวัติ</div>
      ) : (
        data.map((a) => {
          const params = archiveParams(a.file);
          return (
            <Link
              key={a.file}
              to="/archive/$mode/$file"
              params={params}
              target="_blank"
              title={a.outcome}
            >
              {outcomeIcon(a.outcome)} {params.file.replace('.json', '')} —{' '}
              <span className="muted">{truncate(a.outcome, 44)}</span>
            </Link>
          );
        })
      )}
      <Link to="/archive" className="muted">
        ดูทั้งหมด →
      </Link>
    </div>
  );
}
