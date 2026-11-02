import { loginEmail } from "@zentek/shared";

export const LOGIN_DOMAIN = (import.meta.env.VITE_LOGIN_EMAIL_DOMAIN as string | undefined) ?? "";

/** People type a username; owners may also have a real email. */
export function signInEmail(userOrEmail: string): string {
  const v = userOrEmail.trim();
  return v.includes("@") ? v.toLowerCase() : loginEmail(v, LOGIN_DOMAIN);
}

export function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

export function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : new Date(iso).toLocaleDateString();
}

const ERRORS: Record<string, string> = {
  password_too_short: "Use at least 8 characters.",
  password_too_simple: "Pick something harder to guess.",
  password_too_long: "Use 72 characters or fewer.",
  not_allowed: "You can't set a password for this person.",
  licence_limit: "No licences left for this company. Raise the licence count first.",
  username_taken: "That username is taken.",
  bad_username: "Usernames are 3–32 lowercase letters, numbers, dots, dashes or underscores.",
  crew_required: "Pick the technician's crew.",
  app_owner_only: "Only the app owner can do this.",
};
export const errorText = (code: string) => ERRORS[code] ?? code;
