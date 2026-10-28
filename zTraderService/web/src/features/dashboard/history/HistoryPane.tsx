import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { describeError } from '../../../api/client';
import type {
  InstrumentListItem,
  TradeAgg,
  TradeRow,
} from '../../../api/types';
import { DataTable, type Column } from '../../../components/DataTable';
import { fmtPx, money, signClass } from '../../../lib/format';
import { closedShort } from '../../../lib/time';
import { digitsFor, type ActiveInstrument } from '../instruments/instrument';
import { useActiveInstrument } from '../instruments/useActiveInstrument';
import { HISTORY_DAYS } from '../polling';
import { historyQuery } from '../queries';

/** Newest 60 trades are listed (summary covers all of them). */
const MAX_ROWS = 60;

/** 📊 ประวัติเทรด — closed deals of the last 30 days, with/against the H4 trend. */
export function HistoryPane() {
  const { active, list } = useActiveInstrument();
  const { data: h, error, isPending } = useQuery(historyQuery(active.key));
  const columns = useMemo(
    () => (h ? tradeColumns(active, list, h.instrument) : []),
    [active, list, h],
  );

  if (isPending) return <div className="muted">กำลังโหลดประวัติเทรด…</div>;
  if (error)
    return (
      <div className="muted">โหลดประวัติไม่ได้: {describeError(error)}</div>
    );

  const s = h.summary;
  return (
    <>
      <div className="sumgrid">
        <SumBox k={`ไม้ทั้งหมด (${HISTORY_DAYS} วัน)`} v={s.trades} />
        <SumBox k="ชนะ / แพ้" v={`${s.wins} / ${s.losses}`} />
        <SumBox k="Winrate" v={`${s.winrate}%`} />
        <SumBox
          k="กำไรสุทธิ"
          v={'$' + money(s.net_usd)}
          className={signClass(s.net_usd)}
        />
      </div>
      <div className="muted mb10">
        ตามเทรนด์ H4: {trendLine(h.with_h4_trend)} | สวนเทรนด์:{' '}
        {trendLine(h.against_h4_trend)}
      </div>
      <DataTable
        columns={columns}
        data={h.trades.slice(0, MAX_ROWS)}
        getRowId={(t, i) => `${t.position_id}-${t.closed_utc}-${i}`}
      />
    </>
  );
}

function trendLine(a: TradeAgg): string {
  return `${a.trades} ไม้ · winrate ${a.winrate}% · $${money(a.net_usd)}`;
}

function SumBox({
  k,
  v,
  className,
}: {
  k: string;
  v: string | number;
  className?: string;
}) {
  return (
    <div className="sumbox">
      <div className="k">{k}</div>
      <div className={className ? `v ${className}` : 'v'}>{v}</div>
    </div>
  );
}

function tradeColumns(
  active: ActiveInstrument,
  list: readonly InstrumentListItem[],
  historyInstrument: string,
): Column<TradeRow>[] {
  // Each trade uses its own instrument's decimals (EURUSD needs 5).
  const d = (t: TradeRow) =>
    digitsFor(t.instrument ?? historyInstrument, active, list);
  return [
    {
      id: 'closed',
      header: 'ปิดเมื่อ',
      cell: (t) => closedShort(t.closed_utc),
    },
    {
      id: 'side',
      header: 'ทิศ',
      cell: (t) => <span className={t.side.toLowerCase()}>{t.side}</span>,
    },
    { id: 'lots', header: 'Lots', cell: (t) => t.lots.toFixed(2) },
    { id: 'entry', header: 'Entry', cell: (t) => fmtPx(t.entry, d(t)) },
    { id: 'close', header: 'ปิดที่', cell: (t) => fmtPx(t.close, d(t)) },
    {
      id: 'net',
      header: 'สุทธิ',
      cell: (t) => (
        <span className={signClass(t.net_usd)}>{money(t.net_usd)}</span>
      ),
    },
    { id: 'exit', header: 'ออก', cell: (t) => t.exit_kind },
    {
      id: 'h4',
      header: 'H4',
      cell: (t) =>
        t.with_trend === true ? '✅' : t.with_trend === false ? '⚠️สวน' : '—',
    },
    {
      id: 'strategy',
      header: 'กลยุทธ์',
      cell: (t) => t.strategy,
      className: 'muted',
    },
  ];
}
