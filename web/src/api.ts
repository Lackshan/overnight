import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { FlightPaths, LiveSnapshot, Report, Session } from "./types";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Null when Supabase isn't configured: the app still works, everyone is a guest.
export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null;

let token: string | null = null;
let devPlan: string | null = null;

export function setToken(t: string | null) {
  token = t;
}

// Dev mode only: view the app as another plan without paying.
export function setDevPlan(p: string | null) {
  devPlan = p;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (devPlan) headers.set("X-Dev-Plan", devPlan);
  if (init.body) headers.set("Content-Type", "application/json");
  const res = await fetch(path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? "Something went wrong.", body);
  return body as T;
}

export const api = {
  session: () => call<Session>("/api/session"),
  report: (postcode: string) => call<Report>(`/api/report/${encodeURIComponent(postcode.replace(/\s/g, ""))}`),
  // bbox is the visible map area as [west, south, east, north].
  live: (lat: number, lon: number, lines: string[], bbox?: [number, number, number, number]) =>
    call<{ snapshot: LiveSnapshot; locked: string[] }>(
      `/api/live?lat=${lat}&lon=${lon}&lines=${encodeURIComponent(lines.join(","))}${bbox ? `&bbox=${bbox.map((v) => v.toFixed(3)).join(",")}` : ""}`,
    ),
  flightPaths: () => call<FlightPaths>("/api/flightpaths"),
  checkout: (returnPath: string) =>
    call<{ url: string }>("/api/billing/checkout", { method: "POST", body: JSON.stringify({ return_path: returnPath }) }),
  confirm: (sessionId: string) =>
    call<Session>("/api/billing/confirm", { method: "POST", body: JSON.stringify({ session_id: sessionId }) }),
  portal: (returnPath: string) =>
    call<{ url: string }>("/api/billing/portal", { method: "POST", body: JSON.stringify({ return_path: returnPath }) }),
};

// Reports are cached per plan so switching postcodes back and forth is instant,
// and prefetching (on autocomplete highlight) shares the same promise.
const reports = new Map<string, Promise<Report>>();

export function loadReport(postcode: string, plan: string): Promise<Report> {
  const key = `${plan}:${postcode.replace(/\s/g, "").toUpperCase()}`;
  let p = reports.get(key);
  if (!p) {
    p = api.report(postcode);
    p.catch(() => reports.delete(key));
    reports.set(key, p);
  }
  return p;
}

export function clearReports() {
  reports.clear();
}

export interface PostcodeHit {
  postcode: string;
  lat: number;
  lon: number;
  area: string;
}

// Search postcodes straight from the browser; postcodes.io allows CORS and is fast.
export async function searchPostcodes(q: string, signal: AbortSignal): Promise<PostcodeHit[]> {
  const res = await fetch(`https://api.postcodes.io/postcodes?q=${encodeURIComponent(q)}&limit=6`, { signal });
  const body = await res.json();
  return (body.result ?? [])
    .filter((r: { latitude: number | null }) => r.latitude != null)
    .map((r: { postcode: string; latitude: number; longitude: number; admin_ward: string; admin_district: string }) => ({
      postcode: r.postcode,
      lat: r.latitude,
      lon: r.longitude,
      area: [r.admin_ward, r.admin_district].filter(Boolean).join(", "),
    }));
}
