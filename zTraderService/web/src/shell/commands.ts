import type { Role } from '../api/types';
import { hasRole } from '../features/auth/roles';
import { NAV } from './navConfig';

export type Command =
  | {
      kind: 'nav';
      to: string;
      label: string;
      code: string;
      description: string;
    }
  | {
      kind: 'symbol';
      symbol: string;
      label: string;
      code: string;
      description: string;
      then?: string;
    };

/**
 * GO-bar parsing, Bloomberg style: `FUNC`, `SYMBOL` or `SYMBOL FUNC`.
 *   CH → chart · BOT → bot · XAUUSD → chart symbol · EURUSD CH → chart symbol + open chart
 */
export function parseCommand(
  input: string,
  symbols: readonly string[],
  role: Role | undefined,
): Command | null {
  const parts = input.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const [first, second] = parts as [string, string | undefined];
  const navFor = (code: string) =>
    NAV.find(
      (n) => n.codes.includes(code) && (!n.role || hasRole(role, n.role)),
    );
  if (symbols.includes(first)) {
    const target = second ? navFor(second) : undefined;
    return {
      kind: 'symbol',
      symbol: first,
      code: first,
      label: target ? `${first} ${target.label}` : first,
      description: target
        ? `Show ${first} and open ${target.label}`
        : `Show ${first} on the chart`,
      ...(target ? { then: target.to } : {}),
    };
  }
  const nav = navFor(first);
  if (nav)
    return {
      kind: 'nav',
      to: nav.to,
      label: nav.label,
      code: first,
      description: nav.description,
    };
  return null;
}

/** every command the palette/GO bar offers for the current role */
export function allCommands(
  symbols: readonly string[],
  role: Role | undefined,
): Command[] {
  const nav: Command[] = NAV.filter(
    (n) => !n.role || hasRole(role, n.role),
  ).map((n) => ({
    kind: 'nav',
    to: n.to,
    label: n.label,
    code: n.codes[0] ?? n.id.toUpperCase(),
    description: n.description,
  }));
  const syms: Command[] = symbols.map((s) => ({
    kind: 'symbol',
    symbol: s,
    code: s,
    label: s,
    description: `Show ${s} on the chart`,
    then: '/chart',
  }));
  return [...nav, ...syms];
}
