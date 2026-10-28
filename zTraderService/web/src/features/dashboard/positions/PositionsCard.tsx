import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { InstrumentListItem, Position } from '../../../api/types';
import { DataTable, type Column } from '../../../components/DataTable';
import { digitsFor, type ActiveInstrument } from '../instruments/instrument';
import { useActiveInstrument } from '../instruments/useActiveInstrument';
import { positionsQuery } from '../queries';

/** Open positions of every instrument the bot knows (refreshed every 10 s). */
export function PositionsCard() {
  const { active, list, ready } = useActiveInstrument();
  const { data, isError } = useQuery({
    ...positionsQuery(active.key),
    enabled: ready,
  });
  const columns = useMemo(() => positionColumns(active, list), [active, list]);

  let body;
  if (isError) body = <div className="muted">โหลดไม่ได้</div>;
  else if (!data) body = <div className="muted">—</div>;
  else if (!data.length) body = <div className="muted">ไม่มีไม้ค้าง</div>;
  else
    body = (
      <DataTable
        columns={columns}
        data={data}
        getRowId={(p) => String(p.positionId)}
      />
    );

  return (
    <div className="card">
      <h2>
        ไม้ที่ถืออยู่ <span>({active.key})</span>
      </h2>
      {body}
    </div>
  );
}

function positionColumns(
  active: ActiveInstrument,
  list: readonly InstrumentListItem[],
): Column<Position>[] {
  const d = (p: Position) => digitsFor(p.symbol, active, list);
  return [
    { id: 'symbol', header: 'Symbol', cell: (p) => p.symbol || active.key },
    {
      id: 'side',
      header: 'Side',
      cell: (p) => <span className={p.side.toLowerCase()}>{p.side}</span>,
    },
    { id: 'lots', header: 'Lots', cell: (p) => p.lots.toFixed(2) },
    { id: 'entry', header: 'Entry', cell: (p) => p.entry.toFixed(d(p)) },
    {
      id: 'sl',
      header: 'SL',
      cell: (p) => (p.stopLoss ? p.stopLoss.toFixed(d(p)) : '—'),
    },
    {
      id: 'tp',
      header: 'TP',
      cell: (p) => (p.takeProfit ? p.takeProfit.toFixed(d(p)) : '—'),
    },
  ];
}
