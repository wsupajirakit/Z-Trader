import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { BotStatus, InstrumentListItem } from '../../../api/types';
import { instrumentBadgeTitle } from '../instruments/instrument';
import { useActiveInstrument } from '../instruments/useActiveInstrument';
import { statusQuery } from '../queries';
import { marketBadge } from './market';

/**
 * Top bar: account mode, engine, instrument, cTrader link, market hours, live price.
 * While the loop trades more than one instrument, the single badges give way to one small
 * badge per instrument (market dot + price), as in the original.
 */
export function StatusHeader({ actions }: { actions?: ReactNode }) {
  const { data: s } = useQuery(statusQuery);
  const { active, list, ready } = useActiveInstrument();
  const multi =
    s && s.enabled_instruments.length > 1 ? s.enabled_instruments : null;
  const mk = s ? marketBadge(s.market) : null;

  return (
    <header>
      <h1>zTrader</h1>
      <span
        className={'badge ' + (s?.accountMode === 'LIVE' ? 'live' : 'demo')}
      >
        {s ? s.accountMode : '…'}
      </span>
      <span className="badge engine">
        {s ? 'engine: ' + (s.engine || '?').toUpperCase() : '…'}
      </span>
      {multi ? null : (
        <span
          className="badge inst"
          title={ready ? instrumentBadgeTitle(active) : 'ตราสารที่บอทกำลังเทรด'}
        >
          {ready ? active.emoji + ' ' + active.key : '…'}
        </span>
      )}
      <span className="muted">
        <span className={'dot ' + (s?.ctraderAuthorized ? 'on' : 'off')} />
        cTrader
      </span>
      {multi ? (
        <MultiBadges status={s} keys={multi} list={list} />
      ) : (
        <span className={mk?.className ?? 'badge'} title={mk?.title}>
          {mk?.text ?? '…'}
        </span>
      )}
      <span className="spacer" />
      {multi ? null : (
        <span className="price">
          {s?.price?.bid ? s.price.bid.toFixed(active.digits) : '—'}
        </span>
      )}
      {actions}
    </header>
  );
}

function MultiBadges({
  status,
  keys,
  list,
}: {
  status: BotStatus | undefined;
  keys: string[];
  list: InstrumentListItem[];
}) {
  return (
    <span className="multibadges">
      {keys.map((key) => {
        const full = list.find((x) => x.key === key);
        const digits = full ? full.digits : 5;
        const mk = status?.markets[key];
        const px = status?.prices[key];
        return (
          <span key={key} className="multibadge" title={mk ? mk.reason : ''}>
            <span className={'mdot ' + (mk?.open ? 'open' : 'closed')} />
            {(full?.emoji ?? '') + ' ' + key}{' '}
            <span className="mpx">
              {px?.bid ? px.bid.toFixed(digits) : '…'}
            </span>
          </span>
        );
      })}
    </span>
  );
}
