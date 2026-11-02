// Saves the outbox and today's jobs on the tablet so work survives no signal and app restarts.
// localStorage keeps this first slice simple. Before the pilot, swap it for SQLite
// (@capacitor-community/sqlite) or PowerSync: photos and a full day of GPS outgrow localStorage.
import type { OutboxItem, OutboxStore } from "@zentek/shared";

const KEY = "zentek.outbox.v1";

export const localOutboxStore: OutboxStore = {
  async load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? "[]") as OutboxItem[];
    } catch {
      return [];
    }
  },
  async save(items) {
    localStorage.setItem(KEY, JSON.stringify(items));
  },
};

export function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the in-memory copy still works for this session */
  }
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
