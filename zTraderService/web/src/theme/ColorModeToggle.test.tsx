import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppThemeProvider, COLOR_MODE_STORAGE_KEY } from './AppThemeProvider';
import { ColorModeToggle } from './ColorModeToggle';

describe('theme', () => {
  it('starts dark and switches to light, remembering the choice', async () => {
    render(
      <AppThemeProvider>
        <ColorModeToggle />
      </AppThemeProvider>,
    );
    const user = userEvent.setup();
    const toLight = await screen.findByRole('button', {
      name: 'Switch to light theme',
    });
    await user.click(toLight);
    expect(
      await screen.findByRole('button', { name: 'Switch to dark theme' }),
    ).toBeInTheDocument();
    expect(localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBe('light');
  });
});
