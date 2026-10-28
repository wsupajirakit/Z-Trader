export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

/** Usernames are stored lower-cased; the form normalises before sending. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateUsername(raw: string): string | null {
  return USERNAME_RE.test(normalizeUsername(raw))
    ? null
    : 'ชื่อผู้ใช้ต้องยาว 3–32 ตัว ใช้ได้เฉพาะ a-z 0-9 . _ -';
}

/**
 * Client-side copy of the server rule (docs/api.md): 12–128 characters and must not contain
 * the username. The server stays the authority; this only gives an early, Thai message.
 */
export function validateNewPassword(
  password: string,
  username: string,
): string | null {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `รหัสผ่านต้องยาว ${PASSWORD_MIN}–${PASSWORD_MAX} ตัวอักษร`;
  }
  const u = normalizeUsername(username);
  if (u && password.toLowerCase().includes(u))
    return 'รหัสผ่านต้องไม่มีชื่อผู้ใช้อยู่ในนั้น';
  return null;
}
