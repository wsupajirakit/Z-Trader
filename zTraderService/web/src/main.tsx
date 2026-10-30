import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createQueryClient } from './app/queryClient';
import { createAppRouter } from './app/router';
import { installSessionHandlers } from './app/sessionHandlers';

const queryClient = createQueryClient();
const router = createAppRouter({ queryClient });
installSessionHandlers(router, queryClient);

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App queryClient={queryClient} router={router} />
  </StrictMode>,
);
