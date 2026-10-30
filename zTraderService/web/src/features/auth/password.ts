export const PASSWORD_MIN = 9;
export const PASSWORD_MAX = 128;

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

/** usernames are stored lower-cased; forms normalise before sending */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateUsername(raw: string): string | null {
  return USERNAME_RE.test(normalizeUsername(raw))
    ? null
    : 'Username: 3–32 characters, a-z 0-9 . _ - only';
}

/** client copy of the server rule (docs/api.md): 9–128 characters, must not contain the username */
export function validateNewPassword(
  password: string,
  username: string,
): string | null {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`;
  }
  const u = normalizeUsername(username);
  if (u && password.toLowerCase().includes(u))
    return 'Password must not contain the username';
  return null;
}
