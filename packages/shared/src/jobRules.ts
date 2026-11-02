// The rules the crew screen applies before a job can be marked Done.
// Kept here, free of UI code, so the tablet app and the server agree and both are tested.

export type VisitStatus = "scheduled" | "en_route" | "on_site" | "done" | "blocked" | "moved" | "skipped";
export type PlanFrequency = "weekly" | "biweekly" | "seasonal" | "one_time";

export interface NextService {
  serviceKey?: string;
  /** ISO date, YYYY-MM-DD */
  date?: string;
  note?: string;
  /** true when filled in from the customer's plan rather than chosen by the crew */
  fromPlan?: boolean;
}

export interface DoneCheckInput {
  clockedIn: boolean;
  status: VisitStatus;
  tasks: readonly string[];
  checked: readonly string[];
  hasBeforePhoto: boolean;
  hasAfterPhoto: boolean;
  needsMaterials: boolean;
  materialsRecorded: boolean;
  next?: NextService;
}

/** String keys (see i18n) explaining what still blocks Done, in the order the crew meets them. */
export type DoneBlocker = "needClock" | "needBefore" | "needChecks" | "needMat" | "needAfter" | "needNext";

export const REGULAR_SERVICE = "regular";

/** The first thing that still blocks Done, or null when the job can be finished. */
export function doneBlocker(v: DoneCheckInput): DoneBlocker | null {
  if (!v.clockedIn) return "needClock";
  if (v.status !== "on_site") return null; // the main button isn't Done yet
  if (!v.hasBeforePhoto) return "needBefore";
  if (!v.tasks.every((task) => v.checked.includes(task))) return "needChecks";
  if (v.needsMaterials && !v.materialsRecorded) return "needMat";
  if (!v.hasAfterPhoto) return "needAfter";
  const n = v.next;
  if (!n?.serviceKey || !n.date) return "needNext";
  // A short note is only required when the next service differs from a regular visit.
  if (n.serviceKey !== REGULAR_SERVICE && !(n.note ?? "").trim()) return "needNext";
  return null;
}

/** For recurring customers, pre-fill the next service from their plan. */
export function defaultNextService(frequency: PlanFrequency, todayIso: string): NextService | null {
  const days = frequency === "weekly" ? 7 : frequency === "biweekly" ? 14 : null;
  if (days === null) return null;
  return { serviceKey: REGULAR_SERVICE, date: addDays(todayIso, days), fromPlan: true };
}

/** Whether finishing a visit should create a new unassigned job for the office. */
export function createsRecommendedJob(next: NextService | undefined): boolean {
  return !!next?.serviceKey && next.serviceKey !== REGULAR_SERVICE;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
