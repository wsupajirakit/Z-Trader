import { describe, expect, it } from 'vitest';
import { hasRole } from './roles';
import {
  normalizeUsername,
  validateNewPassword,
  validateUsername,
} from './password';

describe('password rule (12–128, must not contain the username)', () => {
  it.each([
    ['short', 'alice', 'รหัสผ่านต้องยาว 12–128 ตัวอักษร'],
    ['x'.repeat(129), 'alice', 'รหัสผ่านต้องยาว 12–128 ตัวอักษร'],
    ['my-ALICE-secret-1', 'alice', 'รหัสผ่านต้องไม่มีชื่อผู้ใช้อยู่ในนั้น'],
    ['correct horse battery', 'alice', null],
    ['x'.repeat(12), 'bob', null],
  ])('%s', (pw, u, expected) => {
    expect(validateNewPassword(pw, u)).toBe(expected);
  });
});

describe('username', () => {
  it('is lower-cased and limited to [a-z0-9._-]{3,32}', () => {
    expect(normalizeUsername('  Alice.B ')).toBe('alice.b');
    expect(validateUsername('Alice.B')).toBeNull();
    expect(validateUsername('ab')).not.toBeNull();
    expect(validateUsername('has space')).not.toBeNull();
    expect(validateUsername('a'.repeat(33))).not.toBeNull();
  });
});

describe('hasRole', () => {
  it('ranks viewer < operator < admin', () => {
    expect(hasRole('admin', 'operator')).toBe(true);
    expect(hasRole('operator', 'operator')).toBe(true);
    expect(hasRole('viewer', 'operator')).toBe(false);
    expect(hasRole(undefined, 'viewer')).toBe(false);
  });
});
