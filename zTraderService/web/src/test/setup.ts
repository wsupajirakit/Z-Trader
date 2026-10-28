import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { configureApiClient, setCsrfToken } from '../api/client';

afterEach(() => {
  cleanup();
  configureApiClient(null);
  setCsrfToken(null);
});

// jsdom has no layout; the router's scroll restoration calls this.
window.scrollTo = () => undefined;
