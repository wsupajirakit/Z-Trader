import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import InputBase from '@mui/material/InputBase';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useInstruments } from '../data/useInstruments';
import { useCurrentUser } from '../features/auth/session';
import { capsLabel } from '../theme/theme';
import { allCommands, parseCommand, type Command } from './commands';
import { useCommandRunner } from './useCommandRunner';

/**
 * GO bar (top row): type a function code (CH, BOT, POS …), an instrument (EURUSD) or both
 * (EURUSD CH) and press Enter. Ctrl+G focuses it.
 */
export function CommandBar() {
  const user = useCurrentUser();
  const { symbols } = useInstruments();
  const run = useCommandRunner();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const options = useMemo(
    () => allCommands(symbols, user?.role),
    [symbols, user?.role],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const execute = (value: string | Command | null) => {
    if (!value) return;
    const cmd =
      typeof value === 'string'
        ? parseCommand(value, symbols, user?.role)
        : value;
    if (!cmd) {
      setError(
        `Unknown command "${typeof value === 'string' ? value.toUpperCase() : value.code}"`,
      );
      return;
    }
    setError(null);
    setInput('');
    run(cmd);
    ref.current?.blur();
  };

  return (
    <Box
      sx={{
        height: 34,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 2,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'terminal.bgAlt',
        flexShrink: 0,
      }}
    >
      <Box
        sx={{
          ...capsLabel,
          bgcolor: 'primary.main',
          color: '#fff',
          px: 1.5,
          py: 0.25,
          fontSize: 11,
          borderRadius: 0.5,
        }}
      >
        GO
      </Box>
      <Autocomplete<Command, false, false, true>
        freeSolo
        options={options}
        inputValue={input}
        onInputChange={(_e, v) => {
          setInput(v);
          if (error) setError(null);
        }}
        onChange={(_e, v) => {
          execute(v);
        }}
        getOptionLabel={(o) => (typeof o === 'string' ? o : o.code)}
        filterOptions={(opts, state) => {
          const q = state.inputValue.trim().toUpperCase();
          if (!q) return opts.slice(0, 12);
          return opts
            .filter(
              (o) =>
                o.code.startsWith(q.split(/\s+/)[0] ?? '') ||
                o.label.toUpperCase().includes(q),
            )
            .slice(0, 12);
        }}
        sx={{ flex: 1, maxWidth: 640 }}
        slotProps={{ paper: { sx: { mt: 0.5 } } }}
        renderOption={(props, o) => {
          const { key, ...rest } = props as typeof props & { key: string };
          return (
            <Box
              component="li"
              key={key}
              {...rest}
              sx={{ display: 'flex', gap: 2 }}
            >
              <Box
                className="num"
                sx={{ color: 'primary.main', fontWeight: 700, minWidth: 64 }}
              >
                {o.code}
              </Box>
              <Box sx={{ flex: 1 }}>{o.label}</Box>
              <Box sx={{ color: 'text.secondary', fontSize: 11 }}>
                {o.description}
              </Box>
            </Box>
          );
        }}
        renderInput={(params) => (
          <InputBase
            ref={params.slotProps.input.ref}
            inputProps={{
              ...params.slotProps.htmlInput,
              'aria-label': 'Command (GO bar)',
            }}
            inputRef={ref}
            placeholder="Function or symbol — e.g. CH, BOT, EURUSD CH   (Ctrl+G)"
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                input.trim() &&
                !document.querySelector('.MuiAutocomplete-option.Mui-focused')
              ) {
                e.preventDefault();
                execute(input);
              }
            }}
            sx={{
              width: '100%',
              fontSize: 12,
              fontFamily: 'inherit',
              '& input': { textTransform: 'uppercase', p: 0 },
            }}
          />
        )}
      />
      {error ? (
        <Box role="status" sx={{ color: 'terminal.down', fontSize: 11 }}>
          {error}
        </Box>
      ) : null}
      <Box
        sx={{
          ml: 'auto',
          display: { xs: 'none', md: 'flex' },
          gap: 2,
          color: 'text.secondary',
          fontSize: 10.5,
          alignItems: 'center',
        }}
      >
        <span>
          <kbd>Ctrl</kbd>+<kbd>K</kbd> palette
        </span>
        <span>
          <kbd>Ctrl</kbd>+<kbd>/</kbd> shortcuts
        </span>
      </Box>
    </Box>
  );
}
