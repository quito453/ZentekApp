// English and Spanish text for both apps. Keys match the clickable demo (demo/index.html).
// Add French by dropping in fr.json with the same keys.
import en from "./i18n/en.json";
import es from "./i18n/es.json";

export type Lang = "en" | "es";
export type StringKey = keyof typeof en;

const TABLES: Record<Lang, Record<string, string>> = { en, es };

/** Look up a string and fill {placeholders}. Falls back to English, then to the key itself. */
export function t(lang: Lang, key: StringKey | string, vars?: Record<string, string | number>): string {
  let s = TABLES[lang][key] ?? TABLES.en[key] ?? String(key);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export function missingKeys(lang: Lang): string[] {
  return Object.keys(en).filter((k) => !(k in TABLES[lang]));
}
