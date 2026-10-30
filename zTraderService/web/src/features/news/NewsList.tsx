import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import { useQuery } from '@tanstack/react-query';
import { ErrorState, EmptyState, LoadingState } from '../../components/States';
import { newsQuery } from '../../data/queries';
import { useInstruments } from '../../data/useInstruments';
import { safeExternalUrl } from '../../lib/safeUrl';

/** headlines for the bot's active instrument; relevant ones are highlighted */
export function NewsList({
  limit,
  compact = false,
}: {
  limit?: number;
  compact?: boolean;
}) {
  const { active } = useInstruments();
  const q = useQuery(newsQuery(active));
  if (q.isPending) return <LoadingState />;
  if (q.isError)
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const items = limit ? q.data.slice(0, limit) : q.data;
  if (!items.length) return <EmptyState>No headlines right now</EmptyState>;
  return (
    <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
      {items.map((n) => {
        const href = safeExternalUrl(n.link);
        return (
          <Box
            component="li"
            key={`${n.link}-${n.title}`}
            sx={{
              py: compact ? 1 : 1.5,
              px: compact ? 0 : 1,
              borderBottom: 1,
              borderColor: 'divider',
              fontSize: compact ? 11.5 : 12,
            }}
          >
            <Box
              sx={{
                display: 'flex',
                gap: 1,
                color: 'text.secondary',
                fontSize: 10,
                mb: 0.5,
              }}
            >
              {n.relevant ? (
                <Box
                  component="span"
                  sx={{ color: 'primary.main', fontWeight: 700 }}
                >
                  ● RELEVANT
                </Box>
              ) : null}
              <span>{n.source}</span>
              <span>
                ·{' '}
                {new Date(n.pubDate).toLocaleString('en-GB', {
                  hour12: false,
                  month: 'short',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </Box>
            {href ? (
              <Link
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                underline="hover"
                color="inherit"
              >
                {n.title}
              </Link>
            ) : (
              n.title
            )}
          </Box>
        );
      })}
    </Box>
  );
}
