import { describe, expect, it } from 'vitest';
import {
  normalizeUsername,
  validateNewPassword,
  validateUsername,
} from './password';

describe('password rule (9–128, must not contain the username)', () => {
  it.each([
    ['short', 'alice', 'Password must be 9–128 characters'],
    ['x'.repeat(129), 'alice', 'Password must be 9–128 characters'],
    ['my-alice-secret', 'alice', 'Password must not contain the username'],
    ['MY-ALICE-secret', 'Alice', 'Password must not contain the username'],
    ['147258369', 'dev', null],
  ])('%s / %s', (pw, user, expected) => {
    expect(validateNewPassword(pw, user)).toBe(expected);
  });
  it('usernames', () => {
    expect(normalizeUsername('  Alice ')).toBe('alice');
    expect(validateUsername('ab')).not.toBeNull();
    expect(validateUsername('dev.ops_1')).toBeNull();
  });
});
