import { describe, expect, it } from "vitest";
import { memoryStore, Outbox, type OutboxItem, type SendResult } from "../src/outbox";

function clock(start = "2026-11-02T15:00:00Z") {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

function setup(results: SendResult[] = []) {
  const c = clock();
  let n = 0;
  const sent: string[] = [];
  const queue = [...results];
  const store = memoryStore();
  const ob = new Outbox(
    store,
    async (item: OutboxItem) => {
      const r = queue.shift() ?? "ok";
      if (r === "ok") sent.push(item.op);
      return r;
    },
    { now: c.now, newId: () => `id${++n}`, baseDelayMs: 1000, maxDelayMs: 8000 },
  );
  return { ob, store, sent, c };
}

describe("Outbox", () => {
  it("sends everything in the order it happened", async () => {
    const { ob, sent } = setup();
    await ob.enqueue("visit.en_route", {});
    await ob.enqueue("visit.arrived", {});
    await ob.enqueue("photo.upload", {}, { kind: "photo", bytes: 2_400_000 });
    await ob.enqueue("visit.done", {});
    const r = await ob.flush();
    expect(sent).toEqual(["visit.en_route", "visit.arrived", "photo.upload", "visit.done"]);
    expect(r).toMatchObject({ sent: 4, remaining: 0 });
  });

  it("stops at a failure so nothing jumps the queue, then retries with a growing delay", async () => {
    const { ob, sent, c } = setup(["ok", "retry", "retry"]);
    await ob.enqueue("visit.arrived", {});
    await ob.enqueue("photo.upload", {}, { kind: "photo" });
    await ob.enqueue("visit.done", {});

    let r = await ob.flush();
    expect(sent).toEqual(["visit.arrived"]);
    expect(r.remaining).toBe(2);

    r = await ob.flush(); // still inside the 1 s wait: nothing is tried
    expect(r.sent).toBe(0);

    c.advance(1000);
    await ob.flush(); // second failure: wait doubles to 2 s
    expect(ob.pending[0]!.attempts).toBe(2);

    c.advance(1500);
    expect((await ob.flush()).sent).toBe(0);
    c.advance(500);
    r = await ob.flush();
    expect(sent).toEqual(["visit.arrived", "photo.upload", "visit.done"]);
    expect(r.remaining).toBe(0);
  });

  it("drops an item that is no longer useful instead of sending it late", async () => {
    const { ob, sent, c } = setup();
    await ob.enqueue("text.on_my_way", {}, { kind: "text", expiresAt: "2026-11-02T15:20:00Z" });
    await ob.enqueue("visit.arrived", {});
    c.advance(30 * 60_000);
    const r = await ob.flush();
    expect(sent).toEqual(["visit.arrived"]);
    expect(r.dropped.map((d) => [d.item.op, d.reason])).toEqual([["text.on_my_way", "expired"]]);
  });

  it("drops what the server rejects and carries on", async () => {
    const { ob, sent } = setup(["drop", "ok"]);
    await ob.enqueue("text.on_my_way", {}, { kind: "text" });
    await ob.enqueue("visit.done", {});
    const r = await ob.flush();
    expect(sent).toEqual(["visit.done"]);
    expect(r.dropped[0]?.reason).toBe("rejected");
  });

  it("treats a thrown error (no signal) like a retry", async () => {
    const store = memoryStore();
    const ob = new Outbox(store, async () => {
      throw new Error("network down");
    });
    await ob.enqueue("visit.arrived", {});
    const r = await ob.flush();
    expect(r.remaining).toBe(1);
    expect(ob.pending[0]!.attempts).toBe(1);
  });

  it("survives the app being closed: a new Outbox picks up the saved queue", async () => {
    const { ob, store } = setup(["retry"]);
    await ob.enqueue("visit.arrived", {});
    await ob.enqueue("photo.upload", {}, { kind: "photo", bytes: 2_400_000 });
    await ob.flush();

    const sent: string[] = [];
    const reopened = new Outbox(store, async (i) => (sent.push(i.op), "ok"), { now: () => new Date("2026-11-02T16:00:00Z") });
    await reopened.load();
    expect(reopened.summary()).toEqual({ count: 2, photos: 1, photoBytes: 2_400_000 });
    await reopened.flush();
    expect(sent).toEqual(["visit.arrived", "photo.upload"]);
  });

  it("runs one flush at a time even if called repeatedly", async () => {
    const { ob, sent } = setup();
    await ob.enqueue("a", {});
    await ob.enqueue("b", {});
    await Promise.all([ob.flush(), ob.flush(), ob.flush()]);
    expect(sent).toEqual(["a", "b"]);
  });
});
