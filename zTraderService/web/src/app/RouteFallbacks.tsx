import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import { Link, type ErrorComponentProps } from '@tanstack/react-router';
import { describeError } from '../api/client';

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      sx={{ p: 6, display: 'grid', placeItems: 'center', minHeight: '60vh' }}
    >
      <Paper sx={{ p: 5, maxWidth: 480, width: '100%' }}>
        <Box component="h2" sx={{ m: 0, mb: 2, fontSize: 15 }}>
          {title}
        </Box>
        {children}
      </Paper>
    </Box>
  );
}

export function NotFound() {
  return (
    <Card title="Page not found">
      <Button component={Link} to="/" variant="outlined">
        Back to the terminal
      </Button>
    </Card>
  );
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <Card title="Something went wrong">
      <Box sx={{ color: 'text.secondary', mb: 3, fontSize: 12 }}>
        {describeError(error)}
      </Box>
      <Button variant="contained" onClick={reset}>
        Try again
      </Button>
    </Card>
  );
}
