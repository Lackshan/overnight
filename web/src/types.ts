// Mirrors the Go API's JSON.

export type PlanId = "anonymous" | "free" | "pro";

export interface FeatureState {
  label: string;
  allowed: boolean;
  unlocks_on?: PlanId;
}

export interface Session {
  plan: PlanId;
  email?: string;
  features: Record<string, FeatureState>;
  limits: Record<string, number>;
  plans: Record<PlanId, { name: string; price_label?: string }>;
  dev_mode: boolean;
}

export interface Place {
  postcode: string;
  lat: number;
  lon: number;
  ward: string;
  district: string;
}

export type SectionId = "aircraft" | "helicopters" | "getting_home" | "air" | "safety" | "emergency";

export interface Point {
  value: number;
  score: number;
}

export interface Section {
  id: SectionId;
  label: string;
  night: number | null;
  day: number | null;
  headline: string;
  day_line: string;
  unit: string;
  measured: boolean;
  sample?: boolean;
  note?: string;
  hourly?: (Point | null)[];
  details?: { label: string; value: string }[];
}

export interface Crime {
  category: string;
  lat: number;
  lon: number;
  street: string;
}

export interface AirSite {
  code: string;
  name: string;
  lat: number;
  lon: number;
  index: number;
  band: string;
  pollutant: string;
}

export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  distance_m: number;
  lines: { id: string; name: string }[];
}

export interface Report {
  place: Place;
  radius_m: number;
  history_days: number;
  night?: { score: number; band: string };
  day?: { score: number; band: string };
  hourly?: number[];
  sections?: Section[];
  breakdown?: { category: string; label: string; count: number }[];
  layers: {
    crime?: Crime[];
    air?: AirSite[];
    stations?: Station[];
    overflights?: { lat: number; lon: number; passes: number }[];
  };
  lines: string[];
  locked: string[];
}

export interface Aircraft {
  hex: string;
  callsign: string;
  reg: string;
  type: string;
  lat: number;
  lon: number;
  alt_ft: number;
  speed_kt: number;
  track: number;
  kind: "police" | "air_ambulance" | "helicopter" | "plane";
  t: number; // when this position was received, Unix ms
}

export interface LiveEvent {
  id: string;
  at: string;
  kind: "police" | "air_ambulance" | "emergency" | "tfl";
  text: string;
  good?: boolean;
  dist_m?: number;
}

export interface LiveSnapshot {
  now: number;
  updated: string;
  aircraft?: Aircraft[];
  aircraft_nearby: number;
  events?: LiveEvent[];
  lines?: { id: string; name: string; severity: number; status: string }[];
}
