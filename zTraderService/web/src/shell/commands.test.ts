import { describe, expect, it } from 'vitest';
import { allCommands, parseCommand } from './commands';

const SYMBOLS = ['XAUUSD', 'EURUSD'];

describe('GO bar commands', () => {
  it('function codes navigate', () => {
    expect(parseCommand('ch', SYMBOLS, 'viewer')).toMatchObject({
      kind: 'nav',
      to: '/chart',
    });
    expect(parseCommand('  BOT ', SYMBOLS, 'viewer')).toMatchObject({
      kind: 'nav',
      to: '/bot',
    });
    expect(parseCommand('RISK', SYMBOLS, 'viewer')).toMatchObject({
      kind: 'nav',
      to: '/settings',
    });
  });
  it('a symbol alone sets the chart symbol; with a function it also navigates', () => {
    expect(parseCommand('eurusd', SYMBOLS, 'viewer')).toEqual(
      expect.objectContaining({ kind: 'symbol', symbol: 'EURUSD' }),
    );
    expect(parseCommand('EURUSD', SYMBOLS, 'viewer')).not.toHaveProperty(
      'then',
    );
    expect(parseCommand('EURUSD CH', SYMBOLS, 'viewer')).toMatchObject({
      kind: 'symbol',
      symbol: 'EURUSD',
      then: '/chart',
    });
  });
  it('admin functions are hidden from lower roles; unknown input gives null', () => {
    expect(parseCommand('USERS', SYMBOLS, 'operator')).toBeNull();
    expect(parseCommand('USERS', SYMBOLS, 'admin')).toMatchObject({
      to: '/admin/users',
    });
    expect(parseCommand('WHAT', SYMBOLS, 'admin')).toBeNull();
    expect(allCommands(SYMBOLS, 'viewer').some((c) => c.code === 'AUDIT')).toBe(
      false,
    );
  });
});
