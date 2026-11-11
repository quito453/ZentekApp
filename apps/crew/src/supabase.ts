import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** null until the environment variables are set (see .env.example). */
// Its own sign-in slot: the Owner and Dispatch apps are on the same website, and without this the
// Tech app would pick up an office login from the same browser.
export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey, { auth: { storageKey: "cc-tech-auth" } }) : null;
