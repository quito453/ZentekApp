// Offline outbox for the crew tablet.
//
// Every change the crew makes is written to the tablet first, then queued here. When there is
// signal, `flush()` sends items strictly in the order they happened. A failure stops the run so
// nothing jumps the queue (e.g. "Done" can never arrive before "Arrived"), and that item waits
// with a growing delay before it is tried again.
//
// Storage and sending are injected, so this file has no network or database code and is tested
// on its own. On the tablet, `store` is SQLite (or PowerSync's upload queue, if we adopt it) and
// `send` calls Supabase.

export type OutboxKind = "data" | "photo" | "text" | "gps";

export interface OutboxItem<P = unknown> {
  id: string;
  op: string; // e.g. "visit.arrived", "photo.upload", "text.on_my_way"
  kind: OutboxKind;
  payload: P;
  createdAt: string; // ISO time on the tablet when the crew did it
  attempts: number;
  nextTryAt?: string;
  /** After this time the item is no longer useful and is dropped, never sent (e.g. an "On my way" text). */
  expiresAt?: string;
  /** Approximate upload size in bytes, for the "2 photos · 4.8 MB" line. */
  bytes?: number;
}

export interface OutboxStore {
  load(): Promise<OutboxItem[]>;
  save(items: OutboxItem[]): Promise<void>;
}

/** What the sender reports for one item. `drop` = the server says it no longer applies. */
export type SendResult = "ok" | "retry" | "drop";

export interface FlushReport {
  sent: number;
  dropped: { item: OutboxItem; reason: "expired" | "rejected" }[];
  remaining: number;
  stoppedOn?: string;
}

export interface OutboxOptions {
  now?: () => Date;
  newId?: () => string;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class Outbox {
  private items: OutboxItem[] = [];
  private loaded = false;
  private flushing: Promise<FlushReport> | null = null;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(
    private readonly store: OutboxStore,
    private readonly send: (item: OutboxItem) => Promise<SendResult>,
    opts: OutboxOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
    this.baseDelayMs = opts.baseDelayMs ?? 2_000;
    this.maxDelayMs = opts.maxDelayMs ?? 5 * 60_000;
  }

  async load(): Promise<void> {
    this.items = await this.store.load();
    this.loaded = true;
  }

  get pending(): readonly OutboxItem[] {
    return this.items;
  }

  summary(): { count: number; photos: number; photoBytes: number } {
    const photos = this.items.filter((i) => i.kind === "photo");
    return { count: this.items.length, photos: photos.length, photoBytes: photos.reduce((a, i) => a + (i.bytes ?? 0), 0) };
  }

  async enqueue<P>(op: string, payload: P, opts: { kind?: OutboxKind; expiresAt?: string; bytes?: number } = {}): Promise<OutboxItem<P>> {
    if (!this.loaded) await this.load();
    const item: OutboxItem<P> = {
      id: this.newId(),
      op,
      kind: opts.kind ?? "data",
      payload,
      createdAt: this.now().toISOString(),
      attempts: 0,
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
      ...(opts.bytes !== undefined ? { bytes: opts.bytes } : {}),
    };
    this.items.push(item);
    await this.store.save(this.items);
    return item;
  }

  /** Send what can be sent, in order. Safe to call often (on reconnect, on a timer); runs one at a time. */
  flush(): Promise<FlushReport> {
    if (!this.flushing) this.flushing = this.run().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async run(): Promise<FlushReport> {
    if (!this.loaded) await this.load();
    const report: FlushReport = { sent: 0, dropped: [], remaining: 0 };
    while (this.items.length) {
      const item = this.items[0]!;
      const now = this.now();
      if (item.expiresAt && Date.parse(item.expiresAt) <= now.getTime()) {
        this.items.shift();
        report.dropped.push({ item, reason: "expired" });
        await this.store.save(this.items);
        continue;
      }
      if (item.nextTryAt && Date.parse(item.nextTryAt) > now.getTime()) {
        report.stoppedOn = item.id;
        break;
      }
      let result: SendResult;
      try {
        result = await this.send(item);
      } catch {
        result = "retry";
      }
      if (result === "retry") {
        item.attempts += 1;
        const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (item.attempts - 1));
        item.nextTryAt = new Date(now.getTime() + delay).toISOString();
        await this.store.save(this.items);
        report.stoppedOn = item.id;
        break;
      }
      this.items.shift();
      if (result === "ok") report.sent += 1;
      else report.dropped.push({ item, reason: "rejected" });
      await this.store.save(this.items);
    }
    report.remaining = this.items.length;
    return report;
  }
}

/** A store that keeps items in memory; for tests and the browser preview. */
export function memoryStore(initial: OutboxItem[] = []): OutboxStore & { saved: OutboxItem[] } {
  const s = {
    saved: structuredClone(initial),
    async load() {
      return structuredClone(s.saved);
    },
    async save(items: OutboxItem[]) {
      s.saved = structuredClone(items);
    },
  };
  return s;
}
