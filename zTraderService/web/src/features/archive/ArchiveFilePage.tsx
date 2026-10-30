import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import { useQuery } from '@tanstack/react-query';
import {
  getRouteApi,
  Link as RouterLink,
  useNavigate,
} from '@tanstack/react-router';
import { archiveFileUrl } from '../../api/dashboard';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { Panel } from '../../components/Panel';
import { ErrorState, LoadingState } from '../../components/States';
import { archiveFileQuery } from '../../data/queries';

const route = getRouteApi('/app/archive/$mode/$file');

/** one archived round as formatted JSON (bar series only with "full") */
export function ArchiveFilePage() {
  const { mode, file } = route.useParams();
  const { full = false } = route.useSearch();
  const navigate = useNavigate();
  const q = useQuery(archiveFileQuery(mode, file, full));
  return (
    <>
      <PageHeader
        title="Archive round"
        subtitle={`${mode}/${file}`}
        actions={
          <>
            <FormControlLabel
              control={
                <Switch
                  checked={full}
                  onChange={(e) => {
                    void navigate({
                      to: '/archive/$mode/$file',
                      params: { mode, file },
                      search: e.target.checked ? { full: true } : {},
                    });
                  }}
                />
              }
              label="Include bars"
            />
            <Button
              component="a"
              href={archiveFileUrl(mode, file, full)}
              target="_blank"
              rel="noopener"
            >
              Raw JSON
            </Button>
            <Button component={RouterLink} to="/archive">
              Back
            </Button>
          </>
        }
      />
      <PageBody>
        <Panel title={file}>
          {q.isPending ? (
            <LoadingState />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          ) : (
            <Box
              component="pre"
              sx={{
                m: 0,
                fontSize: 11,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {JSON.stringify(q.data, null, 2)}
            </Box>
          )}
        </Panel>
      </PageBody>
    </>
  );
}
