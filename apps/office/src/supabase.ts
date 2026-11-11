import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** null until the environment variables are set (see .env.example). */
// Owner, Dispatch and Tech are on the same website, so each keeps its own sign-in slot: one browser
// can have all three open with different logins.
const focus = (import.meta.env.VITE_APP_FOCUS as string | undefined) || "office";
export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey, { auth: { storageKey: `cc-${focus}-auth` } }) : null;
