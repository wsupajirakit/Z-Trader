import { useQuery } from '@tanstack/react-query';
import { safeExternalUrl } from '../../../lib/safeUrl';
import { useActiveInstrument } from '../instruments/useActiveInstrument';
import { newsQuery } from '../queries';

/** 📰 ข่าว — headlines for the human reader; the TA engine does not trade on them. */
export function NewsPane() {
  const { active } = useActiveInstrument();
  const { data, isPending, isError } = useQuery(newsQuery(active.key));

  if (isPending) return <div className="muted">กำลังโหลดข่าว…</div>;
  if (isError) return <div className="muted">โหลดข่าวไม่ได้</div>;

  return (
    <>
      <div className="muted mb8">
        ข่าวสำหรับคนอ่านประกอบ — TA engine ไม่ได้ใช้ข่าวตัดสิน
      </div>
      {data.map((n, i) => {
        const href = safeExternalUrl(n.link);
        return (
          <div className="news-item" key={`${n.link}-${i}`}>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {n.title}
              </a>
            ) : (
              <span>{n.title}</span>
            )}
            <div className="src">
              {n.source} · {n.pubDate}
            </div>
          </div>
        );
      })}
    </>
  );
}
