// Account rules shared by the Edge Functions (Deno) and the apps (re-exported by @zentek/shared).
// Plain TypeScript with no runtime imports, so both can use it.

/** 3–32 characters: lowercase letters, numbers, dot, dash, underscore; starts with a letter or number. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidUsername(raw: string): boolean {
  return USERNAME_PATTERN.test(normalizeUsername(raw));
}

export type PasswordProblem = "too_short" | "too_long" | "too_simple";

/** Short enough to type on a tablet, long enough not to guess. */
export function passwordProblem(pw: string): PasswordProblem | null {
  if (pw.length < 8) return "too_short";
  if (pw.length > 72) return "too_long"; // bcrypt limit
  if (/^(.)\1+$/.test(pw) || /^(0123456789|1234567890|12345678|password)/i.test(pw)) return "too_simple";
  return null;
}

/**
 * Supabase Auth signs people in with an email address. Technicians only ever see a username, so
 * each one gets an internal address on a domain you own that has no mailbox, e.g.
 * `marco.r@users.yourdomain.com`. No email is ever sent to it: passwords are reset by the office.
 */
export function loginEmail(username: string, domain: string): string {
  const d = domain.trim().toLowerCase();
  if (!d || !d.includes(".")) throw new Error("login email domain is not set");
  return `${normalizeUsername(username)}@${d}`;
}

export type Role = "owner" | "dispatcher" | "crew";
export const ROLES: readonly Role[] = ["owner", "dispatcher", "crew"];
