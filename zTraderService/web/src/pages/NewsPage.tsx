import Box from '@mui/material/Box';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { useInstruments } from '../data/useInstruments';
import { NewsList } from '../features/news/NewsList';

export function NewsPage() {
  const { active } = useInstruments();
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      <PageHeader
        title="News"
        subtitle={`Headlines for ${active} (relevant ones are what the AI reads)`}
      />
      <Box sx={{ flex: 1, minHeight: 0, p: 2 }}>
        <Panel title="Headlines">
          <NewsList />
        </Panel>
      </Box>
    </Box>
  );
}
