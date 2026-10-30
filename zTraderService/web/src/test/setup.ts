import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { configureApiClient, setCsrfToken } from '../api/client';

afterEach(() => {
  cleanup();
  configureApiClient(null);
  setCsrfToken(null);
  localStorage.clear();
});

// jsdom has no layout APIs: the router's scroll restoration, MUI's colour-scheme media query,
// and the ResizeObserver used by the chart and the Launchpad grid
window.scrollTo = () => undefined;
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});
class RO {
  observe() {
    return undefined;
  }
  unobserve() {
    return undefined;
  }
  disconnect() {
    return undefined;
  }
}
// assigned directly (not vi.stubGlobal): the config unstubs globals after every test
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
