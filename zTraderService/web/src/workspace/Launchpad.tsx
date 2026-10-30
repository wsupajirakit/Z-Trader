import Box from '@mui/material/Box';
import { GridLayout, useContainerWidth, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import { Panel } from '../components/Panel';
import {
  terminalStore,
  useTerminalPrefs,
  type LayoutItemPref,
} from '../shell/terminalStore';
import { DEFAULT_LAYOUTS } from './layouts';
import { PANELS } from './panels';

/**
 * Free-form tile workspace (OpenTerminalUI Launchpad): drag a panel by its title bar, resize from
 * the corner; the layout is saved per workspace.
 */
export function Launchpad() {
  const prefs = useTerminalPrefs();
  const ws = prefs.workspace;
  const saved = prefs.layouts[ws];
  const layout: LayoutItemPref[] = (
    saved?.length ? saved : DEFAULT_LAYOUTS[ws]
  ).filter((l) => l.i in PANELS);
  const { width, containerRef, mounted } = useContainerWidth();

  return (
    <Box ref={containerRef} sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      {mounted ? (
        <GridLayout
          width={width}
          layout={layout.map((l) => ({ ...l, minW: 2, minH: 3 }))}
          gridConfig={{
            cols: 12,
            rowHeight: 30,
            margin: [8, 8],
            containerPadding: [8, 8],
          }}
          dragConfig={{ handle: '.zt-drag-handle' }}
          resizeConfig={{ handles: ['se'] }}
          onLayoutChange={(next: Layout) => {
            const items = next.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
            const same =
              JSON.stringify(items) ===
              JSON.stringify(
                layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
              );
            if (!same)
              terminalStore.set((p) => ({
                layouts: { ...p.layouts, [ws]: items },
              }));
          }}
        >
          {layout.map((l) => {
            const def = PANELS[l.i];
            if (!def) return null;
            return (
              <div key={l.i}>
                <Panel
                  title={def.title}
                  dense={def.dense}
                  scroll={def.scroll ?? true}
                  dragHandle
                >
                  {def.render()}
                </Panel>
              </div>
            );
          })}
        </GridLayout>
      ) : null}
    </Box>
  );
}
