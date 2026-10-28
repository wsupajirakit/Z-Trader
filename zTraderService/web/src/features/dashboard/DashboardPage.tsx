import { useState } from 'react';
import { SystemLog } from './activity/SystemLog';
import { useActivityPolling } from './activity/useActivityPolling';
import { ArchiveCard } from './archive/ArchiveCard';
import { BotControlCard } from './BotControlCard';
import { HistoryPane } from './history/HistoryPane';
import { NewsPane } from './news/NewsPane';
import { PositionsCard } from './positions/PositionsCard';
import { RiskSettingsCard } from './settings/RiskSettingsCard';
import { LiveStatsCard } from './stats/LiveStatsCard';

type Tab = 'log' | 'hist' | 'news';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'log', label: '📜 System Log' },
  { id: 'hist', label: '📊 ประวัติเทรด' },
  { id: 'news', label: '📰 ข่าว' },
];

/** The trading dashboard: controls and stats on the left, log / history / news on the right. */
export function DashboardPage() {
  useActivityPolling();
  const [tab, setTab] = useState<Tab>('log');

  return (
    <main className="dash">
      <div>
        <BotControlCard />
        <RiskSettingsCard />
        <LiveStatsCard />
        <PositionsCard />
        <ArchiveCard />
      </div>
      <div>
        <div className="card flush">
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? 'active' : undefined}
                onClick={() => {
                  setTab(t.id);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          {/* History and news mount when opened, so each opening loads them fresh. */}
          {tab === 'log' ? <SystemLog /> : null}
          {tab === 'hist' ? (
            <div className="pane-scroll" role="tabpanel">
              <HistoryPane />
            </div>
          ) : null}
          {tab === 'news' ? (
            <div className="pane-scroll" role="tabpanel">
              <NewsPane />
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
