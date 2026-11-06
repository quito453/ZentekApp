// The tablet's single outbox, and how each queued change is sent to Supabase.
import { Outbox, type OutboxItem, type SendResult } from "@zentek/shared";
import { supabase } from "./supabase";
import { localOutboxStore } from "./localStore";

export type VisitUpdate = { visitId: string; patch: Record<string, unknown> };
export type ClockIn = { id: string; company_id: string; crew_id: string; clock_in_at: string; checklist: Record<string, boolean> };
export type ClockOut = { id: string; clock_out_at: string };
export type GpsPoint = { id: string; company_id: string; crew_id: string; shift_id: string; recorded_at: string; lat: number; lng: number; accuracy_m: number | null };
export type GpsBatch = { points: GpsPoint[] };
export type OdometerRead = { id: string; company_id: string; truck_id: string; crew_id: string; reading_km: number; read_at: string };

async function sendItem(item: OutboxItem): Promise<SendResult> {
  if (!supabase || !navigator.onLine) return "retry";
  let error: { code?: string; message: string } | null = null;

  // Ids are made on the tablet, so sending twice (e.g. after a dropped connection) is harmless.
  if (item.op === "visit.update") {
    const { visitId, patch } = item.payload as VisitUpdate;
    ({ error } = await supabase.from("visits").update(patch).eq("id", visitId));
  } else if (item.op === "shift.clock_in") {
    ({ error } = await supabase.from("shifts").upsert(item.payload as ClockIn, { onConflict: "id", ignoreDuplicates: true }));
  } else if (item.op === "shift.clock_out") {
    const { id, clock_out_at } = item.payload as ClockOut;
    ({ error } = await supabase.from("shifts").update({ clock_out_at }).eq("id", id));
  } else if (item.op === "gps.batch") {
    ({ error } = await supabase.from("gps_points").upsert((item.payload as GpsBatch).points, { onConflict: "id", ignoreDuplicates: true }));
  } else if (item.op === "odometer.read") {
    ({ error } = await supabase.from("odometer_readings").upsert(item.payload as OdometerRead, { onConflict: "id", ignoreDuplicates: true }));
  } else {
    return "drop"; // an operation this app version doesn't know
  }

  if (!error) return "ok";
  // Permission refused (row-level security or the crew guard): trying again won't help.
  return error.code === "42501" ? "drop" : "retry";
}

export const outbox = new Outbox(localOutboxStore, sendItem);
