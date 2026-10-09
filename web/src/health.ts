// Opening-hours helpers for GPs and urgent treatment centres.
import type { Hours } from "./types";

const day = (d: Date) => (d.getDay() + 6) % 7; // Monday = 0
const mins = (d: Date) => d.getHours() * 60 + d.getMinutes();

export function openAt(h: Hours, at = new Date()): boolean {
  if (h.open24) return true;
  return (h.days[day(at)] ?? []).some((s) => mins(at) >= s.from && mins(at) < s.to);
}

function clock(m: number) {
  const h = Math.floor(m / 60) % 24, mm = m % 60;
  if (h === 0 && mm === 0) return "midnight";
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 || 12;
  return mm ? `${h12}:${String(mm).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
}

// "Open until 10pm", "Opens 8am", "Opens Monday 8am" or "Open 24 hours".
export function status(h: Hours, at = new Date()): { open: boolean; text: string } {
  if (h.open24) return { open: true, text: "Open 24 hours" };
  const d = day(at), m = mins(at);
  const today = h.days[d] ?? [];
  const now = today.find((s) => m >= s.from && m < s.to);
  if (now) {
    // Runs past midnight into tomorrow?
    const tomorrow = h.days[(d + 1) % 7] ?? [];
    const end = now.to === 1440 && tomorrow[0]?.from === 0 ? tomorrow[0].to + 1440 : now.to;
    return { open: true, text: `Open until ${clock(end)}` };
  }
  const later = today.find((s) => s.from > m);
  if (later) return { open: false, text: `Opens ${clock(later.from)}` };
  const names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  for (let i = 1; i <= 7; i++) {
    const next = h.days[(d + i) % 7]?.[0];
    if (next) return { open: false, text: i === 1 ? `Opens ${clock(next.from)} tomorrow` : `Opens ${names[(d + i) % 7]} ${clock(next.from)}` };
  }
  return { open: false, text: "Closed" };
}
